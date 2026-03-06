# Channel Bridge Core

The channel bridge core is a provider-agnostic runtime that maps external channel conversations to Happier sessions.

Core implementation in this PR:

- Worker/runtime loop: `apps/cli/src/channels/core/channelBridgeWorker.ts`

## Core responsibilities

- receive inbound messages from adapter implementations
- parse shared control commands (`/sessions`, `/attach`, `/session`, `/detach`, `/help`, `/start` as alias of `/help`)
- maintain conversation-to-session bindings by `(providerId, conversationId, threadId|null)`
- forward bound user text into the target session
- fetch assistant output after a cursor and forward back to channel conversations
- track per-binding cursor (`lastForwardedSeq`) to avoid replaying older assistant rows

## Binding model

Bindings are keyed by provider + conversation + optional thread/topic.

- `providerId`: adapter namespace (for example, channel family)
- `conversationId`: channel-specific room/chat identifier
- `threadId`: optional sub-thread/topic identifier
- `sessionId`: Happier session bound to that conversation key
- `lastForwardedSeq`: last assistant transcript row sent through bridge

## Tick loop behavior

Each tick performs:

1. pull inbound messages from each adapter
2. handle control commands (`/sessions`, `/attach`, `/session`, `/detach`, `/help`, `/start`)
3. route non-command user text to bound sessions
4. list current bindings
5. fetch assistant rows after each binding cursor
6. forward assistant messages back through the adapter
7. advance binding cursor after successful forwarding

The worker uses single-flight scheduling in `startChannelBridgeWorker` so only one tick executes at a time.

## Adapter contract

Adapters plug into the core using a small interface:

- `providerId`
- `pullInboundMessages()`
- `sendMessage({ conversationId, threadId, text })`
- optional `stop()` lifecycle hook

This keeps command semantics, binding behavior, and session forwarding logic centralized in the core.

## Scope notes

This document covers core bridge runtime behavior only.

Provider-specific transport details and adapter-specific setup are documented in companion docs (for example, `docs/telegram-channel-bridge.md`).
