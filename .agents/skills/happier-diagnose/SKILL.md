---
name: happier-diagnose
description: Diagnose and explain a Happier runtime, session, daemon, provider (Claude/Codex/OpenCode), authentication, or connectivity incident from logs, structured diagnostics, runtime state, and source evidence without modifying repository implementation. Use for support investigation, incident triage, session-ID analysis, or when the user asks what went wrong; if the user requests a repository fix, hand the established evidence to happier-implement.
metadata: {"openclaw":{"requires":{"bins":["happier"]},"homepage":"https://github.com/happier-dev/happier"}}
---

# Happier Diagnose

Investigate a Happier runtime/support incident from primary evidence, determine the originating cause when the evidence supports it, and report what is known, what is derived, and what remains unverified. Diagnosis is read-only: do not edit repository source or silently turn the investigation into a fix.

For a GitHub issue or coherent issue bundle, use `.agents/skills/happier-issue-diagnose`; it owns untrusted issue intake, private maintainer-evidence capability checks, version/release disposition, and the GitHub-facing report while composing this runtime evidence method when applicable. For a raw multi-issue corpus, use `.agents/skills/happier-issue-triage` first.

If the user requests a repository correction, finish the diagnosis or establish the deciding evidence, then use `.agents/skills/happier-implement` and its bug-fix loop. User-side recovery actions, private diagnostics upload, and public issue creation remain separate actions with their own authority.

## 1. Establish the observed incident

Inspect evidence already supplied or locally available before asking the user for more. Capture:

- observed behavior and failure window;
- expected behavior when it is established;
- affected session, daemon, provider, server, account, host, and platform;
- version/build/runtime identity;
- what still works and the practical impact;
- whether the user wants diagnosis only, local recovery guidance, or later reporting.

If no usable description or evidence exists, ask one concise question that requests the symptom and any Happier session ID or copied session metadata. Do not interrogate or ask for information that safe local/CLI inspection can retrieve.

Do not guess an expected result. Derive it from the user's stated expectation, a current product/external contract, or observed canonical behavior. If it remains materially unspecified, report that ambiguity rather than forcing a root-cause verdict.

## 2. Select the evidence path

Read [runtime-evidence.md](references/runtime-evidence.md) when session metadata, doctor/auth state, Happier logs, provider transcripts, connected-service homes, or installed-version source is needed. In the built-in `/happier-diagnose` prompt, use the bundled runtime-evidence reference included below.

Start with evidence that can discriminate among likely failure layers:

- supplied metadata, logs, and screenshots;
- structured session status and runtime diagnostics;
- daemon/server/provider timelines;
- process, port, filesystem, persistence, browser/network, or service state;
- current or installed-version source, schemas, and tests when they establish reachability or interpret a logged event.

Run `happier doctor --json` and `happier auth status --json` when daemon, server, authentication, lifecycle, process, or connectivity state is material. Do not make doctor a mandatory prelude to an unrelated UI-only or already-decided failure.

Prefer `metadata.sessionLogPath` and `metadata.happyHomeDir` over guessed locations. Anchor searches on time, session/provider IDs, PID, host, and operation. Absence is evidence only about the named files, patterns, and time range searched.

Protect sensitive evidence. Keep raw secrets, credentials, machine identities, full session IDs, and private logs out of public output. Quote only the minimum redacted excerpt needed to support a claim.

## 3. Diagnose the originating layer

Separate symptom, propagation, and cause. Classify where the failure entered:

- user/account/environment configuration;
- daemon, process, service, or connectivity lifecycle;
- provider or external service contract;
- authentication, authorization, encryption, or key state;
- canonical Happier implementation;
- persisted/session state or compatibility;
- test/harness or stale runtime artifact;
- unrelated system.

Trace the observed input and state through the owning decision, side effects, consumers, and visible failure. A nearby error is not automatically causal; prove that it is reachable with the observed inputs and explains the failure.

When evidence supports materially different explanations, name the plausible alternatives and obtain the cheapest observation that distinguishes them. Do not manufacture a second hypothesis when the cause is directly established, and stop expanding the search once the decision-material cause and impact are supported.

Reject a root-cause claim unless supported by primary evidence such as:

- a correlated log/transcript event naming the failure;
- a structured diagnostic or runtime field contradicting healthy state;
- process, network, persistence, or platform state demonstrating the failure;
- source/schema behavior that produces the observed outcome from the observed inputs;
- a controlled reproduction or recovery action that discriminates the cause.

If the evidence is insufficient, report `INCONCLUSIVE` with the observations, plausible remaining causes when material, and the exact evidence that would decide them. Do not pad.

## 4. Evaluate the response separately

A verified cause does not automatically verify a proposed fix.

- For a safe user-side recovery such as re-authentication or a documented restart, provide the exact current command and explain its scope.
- For a repository defect, identify the canonical owner, affected corridor, and root-cause fix direction; do not edit source unless the user requested implementation.
- For a mitigation, label it as such, keep it narrow, and state the remaining owner-level correction.
- For destructive local recovery, external writes, another user's session, managed processes, or shared server state, obtain explicit approval.

Do not delete access keys, daemon state, logs, sessions, or other user data without explicit approval.

## 5. Present the diagnosis

Lead with one of:

- **Root cause verified** — one sentence naming the cause rather than the symptom;
- **Likely cause, not verified** — only when useful, with the missing discriminator;
- **Inconclusive** — what was observed and what evidence is missing.

Then report:

1. **Evidence** — redacted source pointers, timestamps/keys, and concise excerpts;
2. **Impact** — what is broken and what remains unaffected;
3. **Originating layer and canonical owner** — when established;
4. **Recommended response** — user recovery, repository fix direction, mitigation, or next diagnostic action;
5. **Response confidence** — separate from root-cause confidence;
6. **Residual uncertainty** — what would invalidate the conclusion.

Use `.agents/skills/attack-conclusion` against a supported alternative cause or concrete falsifier, neighboring sessions/platforms, stale-runtime gaps, and hypothesis lock before a high-confidence incident verdict. Use `.agents/skills/handoff-report` for the final ordering and epistemic labels.

## 6. Offer reporting only after diagnosis

After presenting the diagnosis, offer private diagnostics upload and/or a sanitized public GitHub issue only when useful. Do not treat reporting as automatic or as proof of diagnosis.

If the user opts in, read [reporting.md](references/reporting.md); in the built-in prompt, use the bundled reporting reference below. Obtain explicit consent separately for the private upload and the public issue. The two paths are complementary, but neither authorizes the other.

## Stop and ask when

- required evidence is sensitive and access was not authorized;
- a recovery action is destructive or changes shared/external state;
- another user's session or a user-managed process would be affected;
- the expected behavior requires a product decision;
- the evidence is inconclusive and the user requests implementation anyway.
