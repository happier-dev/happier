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

Codex exposes structured HTTP `401` and `429` response evidence at this seam. For the exact retained
`0.81.0`, `0.81.1`, `0.82.0`, and `0.82.1` frontier, Happier also admits only the pinned terminal Provider-error
signatures proven by the real Pi `AgentSession` matrix; arbitrary assistant text and uncharacterized
future Pi versions remain non-actionable.

Provider transport retries stay disabled. Pi retains its saved-setting-controlled whole-turn retry
only for exact transient signatures it already classifies as retryable. Happier's request-auth leaf
owns at most one disjoint replay for exact authentication or account-exhaustion failures, and only
after currentness changed, no response output escaped, and a fresh request-auth lookup succeeded.
