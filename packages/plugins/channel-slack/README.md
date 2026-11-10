# Slack Channels

Unreleased 0.3 development provider for Channels c0.73 F1. Slack Socket Mode
uses an outbound WebSocket, so the selected Machine needs no public HTTP
listener. Enable Channels and Slack Channels, connect the app credentials,
then create a connection and bind a conversation to a Session or thread router.
This source implementation is not a stable-release availability claim.

## Prepare a Slack app

Create an app in the workspace that will own the connection. This manifest uses
message events for joined channels, private channels, direct messages and group
direct messages. It deliberately does not also subscribe to `app_mention`:
mentions are recognizable in the message text. Existing apps may subscribe to
either stream or both: the provider maps a post's workspace, channel and exact
native timestamp to one occurrence, so Channels deduplicates twin events even
when Slack gives them different event IDs. App manifest and subscription contracts:
[Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/),
[message events](https://docs.slack.dev/reference/events/message/), and
[app manifests](https://docs.slack.dev/reference/app-manifest/), retrieved
2026-10-20.

```yaml
display_information:
  name: Happier Channels
features:
  bot_user:
    display_name: Happier
    always_online: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - files:read
      - users:read
      - channels:read
      - channels:history
      - groups:read
      - groups:history
      - im:read
      - im:history
      - mpim:read
      - mpim:history
settings:
  socket_mode_enabled: true
  token_rotation_enabled: false
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
```

Install the app to that workspace and invite the bot to the conversations it
should observe. Generate an app-level token with `connections:write`. The
Slack bot Connected Account holds both the non-rotating bot token (`xoxb-`) and
app-level token (`xapp-`) as secrets; Channel setup receives only the account
reference. Rotating-token refresh and organization-wide multi-workspace
installation are outside this first vertical. See
[app tokens](https://docs.slack.dev/authentication/tokens/),
[connections:write](https://docs.slack.dev/reference/scopes/connections.write/),
and [Socket Mode setup](https://docs.slack.dev/apis/events-api/using-socket-mode/),
retrieved 2026-10-20.

## Implementation contract

The provider consumes the existing Channels contribution, Connected Accounts,
background services and HTTP/WebSocket services. Channels remains the owner of
pairing, bindings, Session admission, deduplication, text splitting and delivery
custody. No Slack checkpoint, binding store or HTTP listener is introduced.

Socket Mode obtains a rotating URL with `apps.connections.open`; the app token
must correspond to the bot's app. `auth.test` supplies the workspace/bot IDs,
`bots.info` supplies its `app_id`, and the socket's authenticated
`hello.connection_info.app_id` supplies the comparison during setup, connection
tests and observer startup. Account health verifies that both tokens are
accepted; the shared socket handshake owns app correspondence. Event acknowledgements
follow successful core admission; reconnects cannot promise replay of missed
events. Original posts use workspace/channel/message-timestamp occurrence
identity in the core census; edits retain their separate native `event_id`.
Slack documents message timestamps as unique within a channel:
[message events](https://docs.slack.dev/reference/events/message/), and
[app mentions](https://docs.slack.dev/reference/events/app_mention/), retrieved
2026-11-09.
Sources: [auth.test](https://docs.slack.dev/reference/methods/auth.test/),
[bots.info](https://docs.slack.dev/reference/methods/bots.info/),
[apps.connections.open](https://docs.slack.dev/reference/methods/apps.connections.open/),
[Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/), and
[Events API](https://docs.slack.dev/apis/events-api/), retrieved 2026-10-20.

Endpoint IDs are scoped to the authenticated workspace. `is_im` conversations
are direct; channels and multi-person conversations are shared. A thread uses
its root `thread_ts` below the parent channel. Principals use immutable Slack
user IDs in that workspace, never display-name equality. Exact-ID
`users.info` is an authenticated resolver; unverified or foreign-workspace
identities must use core pairing. Sources:
[conversations.info](https://docs.slack.dev/reference/methods/conversations.info/),
[conversation objects](https://docs.slack.dev/reference/objects/conversation-object/),
[users.info](https://docs.slack.dev/reference/methods/users.info/), and
[message events](https://docs.slack.dev/reference/events/message/), retrieved
2026-10-20.

Select an existing conversation with its Slack channel ID (`C…`, `G…` or `D…`).
An exact thread can be selected with
`slack:<workspace-id>:channel:<channel-id>:thread:<root-ts>`.
The authenticated [`chat.getPermalink`](https://docs.slack.dev/reference/methods/chat.getPermalink/)
response verifies that the selected message exists and normalizes replies to
their root timestamp (retrieved 2026-10-20). Principals accept an exact `U…` or
`W…` user ID, or the provider's workspace-qualified principal ID. Shared-space
pairing uses Channels' existing exact-endpoint proof and owner review.

The output representation is plain text with Slack automatic parsing
disabled and explicit mention delimiters neutralized. Core splits using the
declared 40,000-character native ceiling, rather than treating Slack's 4,000
character recommendation as a hard limit. `chat.postMessage.thread_ts` preserves
thread replies. Both unfurl flags implement link-preview suppression. HTTP 429
`Retry-After` enters core custody; an uncertain send response must not trigger
blind resend. Sources:
[chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/),
[formatting and mention parsing](https://docs.slack.dev/messaging/formatting-message-text/),
[rate limits](https://docs.slack.dev/apis/web-api/rate-limits/), and
[message truncation](https://docs.slack.dev/changelog/2018-truncating-really-long-messages/),
retrieved 2026-10-20.

Socket reconnects report continuity loss through core history-gap/readiness
Actions and preserve the existing explicit baseline-recovery journey. Socket
receive progress is not a durable checkpoint. Edits become bodyless
`unsupportedEdit`; deletes are ignored. Native uploaded files use the shared descriptor and attachment-fetch path.
Rich/shared attachment blocks remain bodyless `unsupportedContent`, so their
fallback text cannot become a command. No HTTP Events API transport is declared.
See [message events](https://docs.slack.dev/reference/events/message/),
[message_changed](https://docs.slack.dev/reference/events/message/message_changed/)
and [message attachments](https://docs.slack.dev/tools/node-slack-sdk/reference/types/interfaces/MessageAttachment/),
retrieved 2026-10-20.

## Release acceptance

The Channels orchestrator owns loaded development-stack QA (`RELOAD NEEDED`).
A real Slack workspace must verify app/bot correspondence,
message scopes, mention notification suppression, Unicode text boundaries,
thread replies, reconnect gaps, rate limits and credential repair before
release. Source tests use documented HTTP/WebSocket boundary fakes and the real
Channels composition/conformance harness. No live workspace or real Slack send
is part of those tests.

## Inbound files (unreleased development source)

Native uploaded files retain their caption and native thread. Descriptors contain
file identity and metadata, never a private download URL or token. On Session
materialization, the provider uses `files.info` with the selected bot's
`files:read` scope and downloads the private bytes without following redirects.
Channels' existing attachment runtime stages and transfers the bytes; a failed
fetch remains visibly unavailable with the admitted message retained. Legacy
attachment blocks remain unsupported. Real Slack-tenant QA is release evidence.
