# Pi Agent plugin

This package owns Happier's Pi Agent integration.

## Connected-account compatibility

Connected-account OAuth uses Pi's complete Provider registration seam and requires
`@earendil-works/pi-coding-agent` version `0.81.0` or newer. Happier probes the selected `pi`
executable before launch and returns the typed
`pi_request_auth_version_unsupported` refusal when the version is older or unreadable.

The boundary is deliberate: immutable `0.81.0`, `0.81.1`, `0.82.0`, and `0.82.1` artifacts expose complete
Provider registration, while `0.80.10` and `0.74.2` do not. No released Happier stable or preview
artifact shipped the former Pi OAuth broker, so there is no supported legacy adapter.

For supported versions, the generated Pi extension performs a fresh local request-auth lookup before
each independent upstream attempt. Pi receives neither provider refresh tokens nor ambient OAuth
credentials, and it keeps no cross-request token cache. API keys and Claude setup tokens remain direct
`auth.json` entries.

Codex exposes structured HTTP `401` and `429` response evidence at this seam. Pi's
`src/agent/auth/services/requestAuth/terminalEvidence.ts` owns the characterized terminal
Provider-error formats and retry facts for `0.81.0`, `0.81.1`, `0.82.0`, and `0.82.1`.
The generated extension normalizes recognized errors into structured category, quota scope,
status and code facts. Generic SDK and Protocol consumers do not interpret Pi versions or
terminal signatures. Arbitrary assistant text and uncharacterized future Pi versions remain
non-actionable through this terminal-error seam.

The native `AgentSession` matrix must resolve compatible SDK/core pairs. In particular, the
`0.81.0` SDK supplies `Agent`'s `streamFunction` option, which core `0.81.0` accepts;
core `0.81.1` expects `streamFn` despite satisfying the SDK's declared `^0.81.0` range.
A mismatched test installation fails before the first Provider request and supplies no
request-auth behavior evidence.

Provider transport retries stay disabled. Pi retains its saved-setting-controlled whole-turn retry
only for exact transient signatures it already classifies as retryable. Happier's request-auth leaf
owns at most one disjoint replay for exact authentication or account-exhaustion failures, and only
after currentness changed, no response output escaped, and a fresh request-auth lookup succeeded.
