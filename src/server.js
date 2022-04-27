import crypto from "crypto";
import express from "express";
import bodyparser from "body-parser";
import http from "http";
import config from "./config.js";
import client from "./client.js";
import {
    linkDiscussion,
    linkPullRequest,
    linkRef,
    linkRepo,
    linkUser,
    msgify,
    truncate,
} from "./format.js";

const app = express();

export default app;

app.use(bodyparser.urlencoded({ extended: true }));
app.use(bodyparser.json());
app.use(bodyparser.raw());

app.use((req, _, next) => {
    if (!req.headers["x-hub-signature-256"]) return;

    const hmac = crypto.createHmac("sha256", config.github_secret);
    const data = hmac.update(JSON.stringify(req.body));
    const hex = data.digest("hex");

    if (hex != req.headers["x-hub-signature-256"].slice(7)) {
        return res.sendStatus(201);
    }

    next();
});

app.use((req, res, next) => {
    if (!req?.body?.repository || req.body.repository.private) {
        return res.sendStatus(201);
    }

    next();
});

app.post("/branch-tag-created", (req, res) => {
    if (req.body.ref_type == "branch") {
        client.room.send(
            `${linkUser(req.body.sender.login)} created branch ${linkRef(
                req.body.ref,
                req.body
            )}`
        );
    }

    res.sendStatus(201);
});

app.post("/branch-tag-deleted", (req, res) => {
    if (req.body.ref_type == "branch") {
        client.room.send(
            `${linkUser(req.body.sender.login)} deleted branch ${
                req.body.repository.name
            }/${req.body.ref}`
        );
    }

    res.sendStatus(201);
});

app.post("/discussion", (req, res) => {
    switch (req.body.action) {
        case "created":
        case "deleted":
        case "pinned":
            client.room.send(
                `${linkUser(req.body.sender.login)} ${
                    req.body.action
                } a discussion in ${linkRepo(req.body.repository)}: ${
                    req.body.action == "deleted"
                        ? req.body.discussion.title
                        : linkDiscussion(req.body.discussion)
                }`
            );
            break;
    }

    res.sendStatus(201);
});

app.post("/fork", (req, res) => {
    client.room.send(
        `${linkUser(req.body.sender.login)} forked ${linkRepo(
            req.body.repository
        )} into ${linkRepo(req.body.forkee)}`
    );

    res.sendStatus(201);
});

app.post("/issue", (req, res) => {
    switch (req.body.action) {
        case "opened":
        case "closed":
        case "reopened":
        case "deleted":
            client.room.send(
                `${linkUser(req.body.sender.login)} opened ${
                    req.body.action == "deleted"
                        ? `issue #${req.body.issue.number}`
                        : linkIssue(req.body.issue, false)
                } in ${linkRepo(req.body.repository)}: _${msgify(
                    req.body.issue.title
                )}_`
            );
    }

    res.sendStatus(201);
});

app.post("/pr-review", (req, res) => {
    if (req.body.action == "submitted") {
        const review = req.body.review;
        let action_text;

        if (review.state == "commented") {
            if (!review.body) return res.sendStatus(201);
            action_text == "commented";
        } else if (review.state == "approved") {
            action_text = "approved";
        } else if (review.state == "changes_requested") {
            action_text = "requested changes";
        } else {
            return res.sendStatus(201);
        }

        client.room.send(
            truncate(
                `${linkUser(req.body.sender.login)} [${action_text}](${
                    review.html_url
                }) on ${linkPullRequest(req.body.pull_request)}${
                    review.body ? `: "${msgify(review.body)}"` : ""
                }`
            )
        );
    }

    res.sendStatus(201);
});

app.post("/pull-request", (req, res) => {
    let action_text = req.body.action;
    const pr = req.body.pull_request;

    if (
        action_text != "opened" &&
        action_text != "closed" &&
        action_text != "reopened"
    ) {
        return res.sendStatus(201);
    }

    if (action_text == "closed" && pr.merged_at) {
        action_text = "merged";
    }

    client.room.send(
        truncate(
            `${linkUser(
                req.body.sender.login
            )} ${action_text} ${linkPullRequest(pr)} (${pr.head.label} → ${
                pr.base.label
            }): _${msgify(pr.title)}_`
        )
    );

    res.sendStatus(201);
});

app.post("/release", (req, res) => {
    const release = req.body.release;
    if (release == lastRelease) return res.sendStatus(201);
    lastRelease = release;

    const name = req.body.repository.full_name;

    client.room
        .send(
            `[**${release.name || release.tag_name}**](${release.html_url})${
                primary.has(name) || secondary.has(name)
                    ? ""
                    : ` released in ${linkRepo(req.body.repository)}`
            }`
        )
        .then((messageId) => {
            if (primary.has(name)) {
                client.room.pinMessage(messageId);
            }
        });

    res.sendStatus(201);
});

app.post("/repository", (req, res) => {
    const repo = req.body.repository;
    const isPrimary = primary.has(repo.full_name);

    let send = true;

    switch (req.body.action) {
        case "created":
            client.room.send(
                `${linkUser(
                    req.body.sender.login
                )} created a repository: ${linkRepo(repo)}`
            );
            send = false;
            break;
        case "deleted":
            client.room.send(
                `${linkUser(req.body.sender.login)} deleted a repository: ${
                    repo.full_name
                }`
            );
            if (isPrimary) {
                client.room.send(responses.PRIMARY_DELETED);
            }
            send = false;
            break;
        case "archived":
            if (isPrimary) {
                client.room.send(responses.PRIMARY_ARCHIVED);
            }
            break;
        case "unarchived":
            break;
        case "publicized":
            break;
        case "privatized":
            if (isPrimary) {
                client.room.send(responses.PRIMARY_PRIVATIZED);
            }
            break;
        default:
            send = false;
            break;
    }

    if (send) {
        client.room.send(
            `${linkUser(req.body.sender.login)} ${req.body.action} ${linkRepo(
                repo
            )}`
        );
    }

    res.sendStatus(201);
});

app.post("/vulnerability", (req, res) => {
    const alert = req.body.alert;

    client.room.send(
        `**${alert.severity} created by ${linkUser(
            req.body.sender.login
        )} in ${linkRepo(req.body.repository)} (affected package: _${msgify(
            alert.affected_package_name
        )}_)`
    );

    res.sendStatus(201);
});

let lastRelease = null;

const primary = new Set(["Vyxal/Sandbox"]);
const secondary = new Set(["Vyxal/Jyxal"]);

http.createServer(app).listen(parseInt(process.argv[2]) || 5666);
