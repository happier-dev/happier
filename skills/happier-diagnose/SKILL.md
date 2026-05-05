---
name: happier-diagnose
description: Diagnose a problem with a Happier session, the daemon, a provider (Claude/Codex/OpenCode), auth, or connectivity. Pulls the correct logs, finds a true root cause from evidence only, presents findings, and optionally uploads a private diagnostics bundle to Happier developers and/or files a sanitized public GitHub issue (the two are complementary). Use when the user reports a bug, says Happier is broken/stuck/misbehaving, asks to debug/diagnose/triage/troubleshoot Happier, or shares a Happier session ID and asks what went wrong.
metadata: {"openclaw":{"requires":{"bins":["happier"]},"homepage":"https://github.com/happier-dev/happier"}}
---

# Happier Diagnose

Investigate a Happier issue from real evidence (logs, doctor output, source), determine the root cause at high confidence, and present findings. Then — only with explicit user consent — upload a private diagnostics bundle to Happier developers **and/or** open a sanitized public GitHub issue. The two paths are complementary: the private bundle gives maintainers raw artifacts; the public issue gives them (and the community) a searchable, durable record. Doing both is normal. Mostly hands-off; minimize questions to the user.

## Evidence rules (read first)

- **High confidence only.** Never guess. Every claim in the final root cause must be traceable to a specific log line, a `happier doctor` field, or a specific source file (with line numbers). If you cannot reach high confidence, say "Inconclusive — here's what I observed and what's missing" rather than inventing a story.
- **Symptom ≠ root cause.** A failed RPC call is a symptom; the daemon being stale, the access key being missing, or a provider returning 429 is a root cause.
- **No fabricated paths or flags.** If a path, file, or command is not in this skill, in the user's logs, or in code you have actually read, do not include it.
- **Concrete code references are welcomed.** The Happier maintainers prefer issues that name specific files (`apps/ui/sources/.../AgentInput.tsx:1759`), include code snippets, and propose a hypothesis. This is repo-relative — different from the user's filesystem paths, which must be sanitized in public issues. See `CONTRIBUTING.md`: "A well-written issue ... is often more useful than a PR."

## Process

### 1. Capture the problem (one question max)

If the user has not already described the issue, ask exactly one question: "What's happening, and is there a Happier session ID involved?" Then start investigating immediately. Do not interrogate.

### 2. Get the session context

Ask the user to send **either** of the following (prefer the first):

- **Preferred:** Open the affected session in the Happier app → Session info screen → press **Copy Metadata**, then paste the JSON. This contains every field needed (`sessionLogPath`, `flavor`, `claudeSessionId`/`codexSessionId`, `host`, `path`, `version`, `os`, `hostPid`, `happyHomeDir`, `machineId`, `startedBy`).
- **Fallback:** The Happier session ID alone, then run `happier session status <id> --json` to fetch metadata server-side. (See the `happier-session-control` skill for the JSON contract.)

If the issue is daemon-wide and not session-specific, skip the session metadata and go straight to step 3.

### 3. Run doctor before reading any log

```bash
happier doctor --json
happier auth status --json
```

`doctor` answers most questions without log digging: daemon up, control port reachable, server reachable, auth state, runaway processes, version mismatch, settings sanity. Read its output before opening logs.

### 4. Pull the right logs

**Always trust `metadata.sessionLogPath` and `metadata.happyHomeDir` over any guess.** Different binaries use different home dirs, and `$HAPPIER_HOME_DIR` overrides them. Common values seen in the wild:

- Release CLI → `~/.happier/logs/`
- Preview CLI → `~/.happier-preview/logs/`
- Dev CLI → `~/.happier-dev/logs/`
- Custom → wherever `$HAPPIER_HOME_DIR` points

If `metadata.sessionLogPath` is missing, fall through the candidate dirs above (in order) and use a glob; never assume a single fixed location.

#### Happier session log

Primary: read `metadata.sessionLogPath` (absolute path). Fallback if absent — search for the file matching `metadata.hostPid`:

```bash
# substitute <happyHomeDir> from metadata, or fall through ~/.happier-dev → ~/.happier → ~/.happier-preview
find "<happyHomeDir>/logs" -maxdepth 1 -name "*-pid-<metadata.hostPid>.log" -not -name "*-daemon.log"
```

Filename format is `YYYY-MM-DD-HH-MM-SS-pid-<pid>.log` (verified on disk).

#### Daemon log

Most recent `*-daemon.log` in `<happyHomeDir>/logs/`. Correlate timestamps with the failure window. There is usually only one active daemon at a time, but stale daemons leave their logs behind, so sort by `mtime`.

#### Claude transcript (when `metadata.flavor === 'claude'` and `metadata.claudeSessionId` is set)

The directory name is the cwd with `/` replaced by `-` (no hash for short paths; only very long paths get a SHA-256 suffix). The session JSONL is named `<claudeSessionId>.jsonl`. **The reliable way is a recursive glob, not computing the path:**

```bash
# search across all Claude project dirs at once
find ~/.claude/projects -maxdepth 2 -name "<claudeSessionId>.jsonl" -type f
```

If nothing matches, ask the user whether their Claude data dir is non-default (`$CLAUDE_CONFIG_DIR` or similar) and re-run with that root.

Note: alongside `<claudeSessionId>.jsonl` you may see a sibling **directory** of the same name — these are sub-session artifacts. The `.jsonl` file itself is the transcript.

Note on `--resume`: when a Happier session resumes a Claude session, Claude writes a NEW `<new-uuid>.jsonl` containing the full prior history with all `sessionId` fields rewritten to the new UUID. The original `<old-uuid>.jsonl` remains as a historical artifact. If you only have the older ID, the latest transcript may live in a different filename — sort the project dir's `.jsonl` files by `mtime` to find the active one.

#### Codex transcript (when `metadata.flavor === 'codex'` and `metadata.codexSessionId` is set)

Codex stores rollouts under date-partitioned subdirs (and an `archived_sessions/` dir for older ones). Do **not** assume `~/.codex/sessions/rollout-*.jsonl` flat. Use a recursive glob:

```bash
# CODEX_HOME defaults to ~/.codex; fall back to ~/.codex if unset
find "${CODEX_HOME:-$HOME/.codex}" -type f \( -name "rollout-*-<codexSessionId>.jsonl" -o -name "rollout-*-<codexSessionId>.json" \) 2>/dev/null
```

Both `.jsonl` (current) and `.json` (legacy) extensions exist. Filename pattern: `rollout-YYYY-MM-DDTHH-MM-SS-<codexSessionId>.jsonl`. Real-world locations include `~/.codex/sessions/<year>/<month>/<day>/`, `~/.codex/sessions/` directly (legacy flat), and `~/.codex/archived_sessions/` (rotated).

If the agent is also running on a connected-services daemon, Codex sessions can live under `<happyHomeDir>/servers/<serverId>/daemon/connected-services/homes/<connectedServiceId>/<profileId>/codex/codex-home/sessions/...` — same filename pattern, different root. Search this root only if the standard glob returns nothing.

#### OpenCode transcript (when `metadata.flavor === 'opencode'` and `metadata.opencodeSessionId` is set)

OpenCode follows XDG storage. Base dir is `$XDG_DATA_HOME/opencode/` (defaults to `~/.local/share/opencode/` on macOS/Linux). There is no single transcript file — session content is keyed by session id (`ses_<...>`) across category subfolders inside `<base>/storage/` (e.g. `session_diff/`, `directory-readme/`, `agent-usage-reminder/`). Find every file for the session at once:

```bash
find "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/storage" -type f -name "<opencodeSessionId>.json" 2>/dev/null
```

Concatenate or `Read` each file. If a Happier connected-services daemon owns the OpenCode session, the same layout lives under `<happyHomeDir>/servers/<serverId>/daemon/connected-services/homes/<connectedServiceId>/<profileId>/opencode/...`.

OpenCode also writes global timestamped logs to `<base>/opencode/log/<YYYY-MM-DDThhmmss>.log`. These are not per-session — correlate by the failure timestamp from the session log.

#### Reading & searching

Read with `Read` (not `cat`/`tail` via Bash) so secrets stay out of the shell pipeline. Search with ripgrep. Anchor on the failure timestamp and `metadata.hostPid` to filter noise.

### 5. Cross-reference source code only when logs are insufficient

If a log message points to specific behavior you cannot interpret without seeing the code, clone the repo at the user's installed version into a tempdir:

```bash
git clone --depth 1 --branch v<metadata.version> https://github.com/happier-dev/happier /tmp/happier-diagnose-<sessionId> \
  || git clone --depth 1 https://github.com/happier-dev/happier /tmp/happier-diagnose-<sessionId>
```

Anchor reading on these directories: `apps/cli/src/`, `apps/server/sources/`, `packages/protocol/src/`, and the docs in `docs/` (`cli-architecture.md`, `protocol.md`, `encryption.md`, and the per-provider `*-feature-matrix.md`). Skip the clone if logs already explain the failure.

### 6. Form the root cause

Synthesize evidence into a single root cause. Reject a candidate cause unless you have at least one of:

- A log line that names it (with timestamp).
- A `doctor` field whose value contradicts a healthy state.
- Source code that demonstrates the failure mode given the observed inputs.

Common, evidence-anchored root causes to recognize (each with the log/field that confirms it):

- **Auth missing/expired** — `happier auth status --json` returns unauthenticated, or `access.key` absent in `<happyHomeDir>/`.
- **Daemon down or stale** — `doctor` reports daemon not reachable; `daemon.state.json` PID does not match a running process; runaway happier processes listed.
- **Server unreachable** — `happier server test` fails; daemon log shows Socket.IO connect timeouts.
- **Provider rate limit / credentials** — provider transcript shows 429 or 401; CLI session log surfaces the provider error.
- **Encryption / key mismatch** — session log mentions decrypt failure; client `dataEncryptionKey` does not match server's.
- **RPC method not available** — error code `RPC_METHOD_NOT_AVAILABLE`; capabilities probe shows the method missing for the provider/server policy.
- **Version mismatch** — `metadata.version` (CLI) older than daemon's recorded version in `daemon.state.json`.
- **Tmux/terminal attach** — `metadata.terminal.tmuxFallbackReason` populated.

If evidence is thin: say so. Do not pad.

### 7. Present findings to the user

Output this template directly in the chat, before offering any uploads:

<diagnosis-template>

**Root cause** — One sentence naming the cause (not the symptom).

**Evidence** — Bulleted, each with the source:
- `<repo-path-or-doctor-field>:<line-or-key>` — quoted snippet (≤120 chars, redact secrets).

**Impact** — What's broken because of this, and what's not.

**Recommended fix** — The smallest change that resolves the cause. If user-side (re-auth, restart daemon, set env var), give the exact command. If it's a Happier bug, name the file(s) and a concrete proposed change — the maintainers welcome this level of detail in issues.

**Confidence** — high / medium / inconclusive, with one sentence on why.

</diagnosis-template>

### 8. Offer to share — two paths, complementary, explicit consent for each

After presenting findings, ask the user (verbatim):

> "Want me to send this to Happier developers? I can do either or both — they're complementary:
> A) **Private diagnostics upload** to Happier's bug-report service (logs and the relevant transcripts — only Happier developers see it).
> B) **Public GitHub issue** at `happier-dev/happier` with reproduction steps, root cause, and (if Path A ran) the diagnostics `reportId` so maintainers can correlate."

Wait for the user to pick. Confirm before each action. Never run either without an explicit "yes". If the user picks both, run Path A first so its `reportId` can be referenced in Path B's body.

#### Path A — Private upload via `happier bug-report`

This collects diagnostics, redacts and sanitizes them, uploads to Happier's bug-report service, and prints a `reportId` and `issueUrl` on success. Attach the specific session log and provider transcript you located in step 4 — they're the most useful artifacts for the maintainers.

```bash
happier bug-report \
  --title "<short, specific title from root cause>" \
  --summary "<2-4 sentence summary>" \
  --current-behavior "<what user observed>" \
  --expected-behavior "<what should have happened>" \
  --repro-step "<step 1>" --repro-step "<step 2>" \
  --frequency <always|often|sometimes|once> \
  --severity <blocker|high|medium|low> \
  --session-id <happier-session-id-from-metadata> \
  --attach-session-log <metadata.sessionLogPath> \
  --attach-provider-transcript <claude-or-codex-or-opencode-transcript-path> \
  --include-diagnostics \
  --accept-privacy-notice
```

Notes:
- Repeat `--attach-provider-transcript <path>` (or `--attach <path>`) if there are multiple files.
- Add `--existing-issue-number <N>` to comment on an existing issue instead of opening a new one.
- Use `--no-include-diagnostics` (and drop the `--attach-*` flags) if the user wants to submit without artifacts.
- Capture the printed `reportId` and `issueUrl` and show both back to the user.

#### Path B — Public GitHub issue via `gh`

Only when the user opted into Path B. First verify `gh` is installed and authenticated (`gh auth status`); if not, tell the user and stop — do not proceed.

Match the format of `happier-dev/happier#91` and `#93` (the maintainers' canonical examples). Title: specific and descriptive, with a platform prefix when relevant — e.g. `Android: Expand/open icon on tool items unresponsive to touch`, not `icon broken`. Body sections, in this order: `## Description`, optional `### Observed behavior` (numbered), `## Root Cause` (with code snippets and repo-relative `path/to/file.ts:line` references), `## Suggested Fix` (concrete code or approach), `## Affected Files` (bulleted with line numbers), and `## Environment` (CLI version, OS, provider).

Repo-relative paths (`apps/ui/sources/components/...:1759`) and code snippets are encouraged. Do **not** include: log contents, the user's absolute filesystem paths, hostnames, machine IDs, full Happier session IDs, full provider session IDs, access keys, or API tokens. If Path A ran, include the `reportId` so maintainers can correlate.

```bash
gh issue create --repo happier-dev/happier \
  --title "<platform prefix if relevant>: <specific, descriptive title>" \
  --body "$(cat <<'EOF'
## Description

<one paragraph: what the user did, what they expected, what actually happened>

### Observed behavior

1. <step + outcome>
2. <step + outcome>
3. <step + outcome>

## Root Cause

<one or two paragraphs naming the cause, then code snippets from the repo with file:line references. Quote 5-15 lines of relevant code in fenced blocks.>

## Suggested Fix

<concrete code change or approach. Code block if applicable.>

## Affected Files

- `apps/.../File.tsx` (line N — <one-line note>)
- `apps/.../Other.ts` (line M — <one-line note>)

## Environment

- Happier CLI: <metadata.version>
- OS: <metadata.os>
- Provider: <metadata.flavor>
- Diagnostics: reportId=<from Path A, if available>
EOF
)"
```

If the user only has a symptom and no concrete code-level finding (i.e., step 6 returned "inconclusive"), still file the issue — the contribution guidelines explicitly value "a well-written issue ... clear repro steps, platform context, observed vs expected behavior" even without a hypothesis. In that case, omit `## Root Cause` and `## Suggested Fix` and lead with `## Description` + `### Steps to reproduce`. Show the user the issue URL after creation.

## Privacy

- **Path A (private upload)**: only Happier developers see the bundle. `happier bug-report` redacts and sanitizes for you — you don't need to pre-redact files before passing them to `--attach-*`.
- **Path B (public GitHub issue)**: world-readable forever. **Allowed in the body:** repo-relative paths, code snippets from the public repo, reproduction steps, platform info. **Never include in the body:** log contents, the user's absolute filesystem paths, hostnames, machine IDs, full session IDs, access keys, OAuth tokens, or provider API keys.

## When to stop and ask

- The fix would change shared state outside the user's machine (server, GitHub, another user's session).
- Evidence is inconclusive but the user is pushing for a fix anyway — say so and let them decide.
- The "fix" requires deleting files (`access.key`, `daemon.state.json`, log files): confirm first.
