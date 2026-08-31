# Happier runtime evidence

Use only the sections relevant to the incident. Paths and commands are discovery aids, not proof; verify current output and installed-version behavior.

## Session context

Prefer copied Session info metadata when available. Useful fields include `sessionLogPath`, `flavor`, provider session ID, `host`, `path`, `version`, `os`, `hostPid`, `happyHomeDir`, `machineId`, and `startedBy`.

With only a Happier session ID, use the `happier-session-control` contract:

```bash
happier session status <session-id-or-prefix> --json
```

For daemon-wide incidents, session metadata may be unnecessary.

## Structured runtime diagnostics

When daemon, server, auth, process, version, or connectivity state is material:

```bash
happier doctor --json
happier auth status --json
```

Interpret the returned fields rather than assuming that command success means the subsystem is healthy.

## Happier homes and logs

Trust `metadata.happyHomeDir` and `metadata.sessionLogPath` over guesses. `$HAPPIER_HOME_DIR` can override defaults. Common homes include:

- release: `~/.happier/`;
- preview: `~/.happier-preview/`;
- development: `~/.happier-dev/`;
- custom: the configured home.

Primary session evidence is `metadata.sessionLogPath`. When absent, search the resolved home for the `hostPid`:

```bash
find "<happyHomeDir>/logs" -maxdepth 1 -name "*-pid-<hostPid>.log" -not -name "*-daemon.log"
```

Daemon evidence is normally the relevant `*-daemon.log` in the same home. Correlate by time and process identity; stale daemon logs may remain.

## Claude transcript

When the session flavor is Claude and `claudeSessionId` is available:

```bash
find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" -maxdepth 2 -type f -name "<claudeSessionId>.jsonl"
```

Resume may create a newer transcript ID containing prior history. If the exact ID is absent, use session/log timing and recent project transcripts to identify the active file rather than assuming a filename.

## Codex transcript

Codex rollouts can be date-partitioned, legacy-flat, or archived:

```bash
find "${CODEX_HOME:-$HOME/.codex}" -type f \( -name "rollout-*-<codexSessionId>.jsonl" -o -name "rollout-*-<codexSessionId>.json" \) 2>/dev/null
```

For connected-services sessions, the same layout may exist under:

```text
<happyHomeDir>/servers/<serverId>/daemon/connected-services/homes/<connectedServiceId>/<profileId>/codex/codex-home/
```

Search that root only when session metadata or standard-path results indicate it is relevant.

## OpenCode evidence

OpenCode follows XDG storage. Session content may be distributed across storage categories:

```bash
find "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/storage" -type f -name "<opencodeSessionId>.json" 2>/dev/null
```

Global OpenCode logs normally live under the same base in `opencode/log/`; correlate them to the Happier failure window. Connected-services sessions may instead use:

```text
<happyHomeDir>/servers/<serverId>/daemon/connected-services/homes/<connectedServiceId>/<profileId>/opencode/
```

## Source and contract correlation

Use current workspace source when diagnosing the current checkout. For an installed release, inspect the source corresponding to `metadata.version` when decision-material:

```bash
git clone --depth 1 --branch "v<version>" https://github.com/happier-dev/happier "<temporary-directory>"
```

If that immutable tag is unavailable, report the fallback basis rather than implying exact version correspondence. Relevant owners commonly live under:

- `apps/cli/src/`;
- `apps/server/sources/`;
- `apps/ui/sources/`;
- `packages/protocol/src/`;
- repository runtime, compatibility, provider, encryption, and CLI architecture docs.

Use source when it establishes reachability, ownership, state transitions, or the meaning of a log event—not only after every log-reading path is exhausted.

## Evidence patterns worth recognizing

These are hypotheses to verify, not a checklist or exhaustive taxonomy:

- auth missing/expired: structured auth status or a correlated 401/403;
- daemon down/stale: doctor/process state and daemon identity disagree;
- server/connectivity failure: correlated transport failures or timeouts;
- provider rate limit/credentials: provider transcript and surfaced status agree;
- encryption/key mismatch: explicit envelope/decryption failure with mode/key evidence;
- unavailable RPC/capability: stable error plus current policy/capability result;
- version or stale-artifact mismatch: runtime identity differs from the source/bundle assumed by the test;
- terminal/tmux attach failure: attachment state or fallback reason demonstrates it.

Do not infer a root cause from the category label alone.
