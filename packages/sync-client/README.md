# Sync client

`@happier-dev/sync-client` is a private, development-only workspace package for Happier's shared HTTP and Socket.IO wire primitives. The UI, CLI, and live SDK consume the same socket construction, RPC cancellation and content codecs, transcript page parsing, ordered history drain, and targeted row repair.

The package owns no credentials, product store, reconnect policy, or transcript materialization. Callers supply encryption context, HTTP requests, connection supervision, abort signals, and any operation timeout or page-size bound. Plain and encrypted stored envelopes are parsed explicitly; unavailable keys and mismatched content modes remain typed results rather than being reinterpreted as plaintext.

For pooled transports, a socket lease can supply `retain()`, returning a release callback. The shared RPC issuer takes that use immediately before emission and releases it when the native acknowledgement resolves or rejects, even if local cancellation or a portable deadline settles the caller first. The pool keeps ownership of entry lifetime and idle retirement; the issuer does not decorate the physical Socket.IO socket or replace its timeout scope and buffer handling.

`createHappierSocket` returns both the raw Socket.IO socket and its managed transport adapter. Socket roles establish the wire scope; reconnect behavior belongs to the caller's connection supervisor. `followSession` attaches before draining history, delivers new rows in sequence order, emits revisions without advancing the cursor, and passes validated stream segments to the caller's session-core assembler. A live sequence gap triggers an authoritative history drain; authoritative pages may contain holes left by discarded imports. Buffering lasts only for the active follower lifetime.

Targeted repair reuses the same page boundary and lets the caller acknowledge applied message IDs. A repair cannot substitute for the caller's store application or currentness checks.
