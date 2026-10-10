# Embedded sessions (0.3 development)

The embed development contract puts Happier's real Session transcript, composer,
tool cards and approvals inside a host application's iframe. This is unreleased
Developer Preview work. The contract below describes the current implementation
target; it does not certify the composed browser journey or package publication.

The approved owner is
[Embed v1](../.project/plans/2026-09-24-embeddable-happier/04-embed-v1.md).
The public developer guide lives at
[`apps/docs/content/docs/extending/embed.mdx`](../apps/docs/content/docs/extending/embed.mdx).

## Credential and authority ownership

An embed is a parent API Token with an attached `EmbedConfigV1`, not a separate
credential type. Its grant owns allowed browser origins, Send, optional Approve,
model and permission-mode restrictions, and bound Session creation. Configuration
owns appearance, control visibility, listing organization and the choice to show
a new-chat composer. Hiding a control never revokes the corresponding API authority.

The host backend keeps the parent credential. It authenticates its own user and
checks that user may open the selected Session before minting a short-lived child.
The browser receives only that child and, for E2EE, sealed Session material. A
Session child names one Session and drops creation and listing authority. A
new-chat child only creates on the grant's bound machine and Agent, in a managed
directory with the bound placement; it cannot read or send to existing Sessions.

The backend parent has Account-wide Session targets for its granted Actions.
Configured folder and tags are listing defaults, not access restrictions on that
key. The backend's per-user authorization and the explicit Session child provide
the conversation boundary.

For a new chat, keep the issued child-to-host-user association until the backend
has checked the credential request. Pass the child's id as `requireCreatedBy`
when exchanging it for the Session child. The token owner verifies Session
creation attribution at mint time. A browser-provided Session id or
`onSessionCreated` notification alone does not authorize that exchange.

The host callback receives `sessionId` when opening a Session, the frame's
`embedPublicKey`, and a `reason` (`initial`, `expiring`, `rejected`, `open` or
`created`). A `created` request also carries `createdByTokenId`; the backend must
check it against the child associated with that signed-in host user before using
it as `requireCreatedBy`. It is an attribution claim, not a browser credential.
Keep the SDK result's `tokenId` on the backend for this association. Return only
the bridge credential fields (`token`, `expiresAt`, and optional `sessionKey` and
`sessionOptions`) to `getCredential`; its strict schema rejects extra fields.

The SDK helpers are thin compositions over existing token, spawn and listing
owners. Creation keeps the incumbent request identity across retries. Folder/tag
listing uses saved organization unless explicit folder/tag overrides are supplied,
and requires a resolved filter; tags match ANY. A host must still apply its own
per-user visibility rules to the results.

## Frame and bridge boundary

The host package mounts `/embed/session/<id>` or `/embed/new` on the Happier UI
origin. The bridge uses a strict V1 envelope, frame identity and request sequence.
The public `ready` handshake may use `'*'`; credential-bearing `init` must use
the exact Happier origin and transfers a MessagePort. Subsequent messages use
that port. Source, origin, identity and payload validation are all required.

The frame performs one token-self request before deciding whether to admit a
credential. It checks the browser-supplied immediate parent origin against
`grant.origins`, and every `location.ancestorOrigins` entry where the browser
exposes that API. A refused origin receives `origin_not_allowed`; no Session read,
subscription or mutation follows. There is one origin store, the token grant.

The server UI owner (`enableServeUi.ts`) sends
`Content-Security-Policy: frame-ancestors 'none'` for non-embed HTML, including SPA
fallback responses. Only the exact `/embed/` path prefix is exempt. The webapp
nginx deployment applies the same separation. `/embed/preview` must remain framable
for the same-origin Settings preview. Its guest takes `configure` from exactly one
sender: its same-origin parent frame on web, or the app's WebView engine (injected host
messages) when native Settings loads the route from this Home's web app. Once listening
it sends the bridge's `state` message and Settings answers with the current
configuration. The preview renders the real embedded parts (standard layout, transcript
rows over a read-only sample source, the real composer) with local no-op interaction; it
holds no credentials and makes no requests.

### What the browser check protects

The browser supplies `event.origin`; the parent cannot forge an allowed origin.
An arbitrary page can load an embed route, but that route has no Session authority
until a child is handed in and admitted. A stolen child cannot be used through the
frame from a disallowed parent origin.

Origins are a browser restriction, not protection against server-to-server misuse
of a stolen bearer. That misuse is bounded by the child's grant, target and expiry.
Keep credentials out of URLs, logs, persistent frame storage and host bundles.

Browsers without `location.ancestorOrigins`, including Firefox before version 148,
leave the frame able to check only its immediate parent; it cannot establish an
all-ancestors anti-clickjacking policy there. See the current
[browser compatibility data](https://developer.mozilla.org/en-US/docs/Web/API/Location/ancestorOrigins#browser_compatibility).
The dashboard must enforce its own framing restrictions, for example:

```http
Content-Security-Policy: frame-ancestors 'none'
```

The [CSP framing directive](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors)
applies to every ancestor. If the dashboard intentionally supports framing,
replace `'none'` with its own
explicit trusted ancestor policy. This header belongs to the dashboard response,
not to the Happier iframe response. Review any reverse-proxy CSP or
`X-Frame-Options` policy: an inherited framing denial on `/embed/` prevents the
embed and preview from loading. Cloud header checks after deployment are release
validation, separate from source-level server tests.

## Encryption and host trust

Plain Sessions require no Account or Session data-encryption material. E2EE
Sessions require a standalone per-Session key envelope. Support depends on that
envelope's availability, not the Session's creation date or component version.
`apps/cli/src/api/client/encryptionKey.ts` still creates Account-secret-keyed
Sessions for a `legacy` credential, without a standalone key. Such Sessions,
including newly created ones, cannot be transferred to the frame and must return
`session_key_not_transferable`. No Account-key fallback is permitted.

The E2EE frame generates an X25519 pair in memory. The backend SDK opens the
Session DEK with the parent credential's content access and seals it to that frame
key using the canonical 105-byte `EncryptedDataKeyEnvelopeV1`. It separately seals
the bounded composer-options projection. In the normal handoff, the host page
transports opaque blobs without receiving the DEK or opened owner metadata. Session hydration
and model/config options still use their existing canonical owners.

Both the credential-serving backend and active host-page code are trusted. The
backend's `hapc` content access can read every Session the Account can read. The
opaque handoff avoids plaintext disclosure during ordinary pass-through, but the
credential endpoint accepts the recipient public key from the host page. An
authorized hostile host script can supply its own key and open the returned
Session key and options. The handoff does not authenticate the recipient as a
Happier frame or protect against a compromised host page. Use a dedicated Account
whose content you trust the dashboard backend and page code to access.
Revocation ends future credential access and cascades to
children; it cannot recall keys or content already disclosed.

In-frame new-chat creation sends no message content in `session.spawn_new`. After creation,
the Session credential/key exchange completes before the preserved draft is sent
through the normal encrypted message path. Missing or unopenable material fails
closed with a typed embed state, without plaintext fallback or repair prompts.
See [Encryption and data encoding](encryption.md#embed-key-handoff-development).

## Presentation, lifecycle and styling

The embed consumes the canonical chrome-less Session presentation and Session-scoped
app sync. It must not bootstrap Account settings, use a user-scoped socket, read
stored app credentials, or compete with the Session transcript or capability owners.
The Session detail response owns the frame's capability projection; shared room
updates cannot replace it with another viewer's access.

The latest requested target controls credential admission. Superseded credential
results are dropped, old Session scopes are disposed before replacement, and
`destroy()` closes the port and removes the frame. `session.created` reports a
fact; it does not override a host's later `open()` request. Credential refresh or
grant edits use the same host credential callback and preserve the draft on a
reconnect; a failed re-mint is an error, not wider fallback authority.

`EmbedStyleV1` maps to the app's theme owner: color roles, typography, font-file
URLs, text scale, radius, density and part radii. Defaults come from Happier;
saved configuration is overridden by host runtime style. Runtime style changes
must repaint without remounting the Session subtree. HTTPS font files are supported
by the contract (loopback in development); CSS stylesheet URLs are not. Failed
font loading falls back to the Happier family.

The wire style requires `v: 1`; the host package's `EmbedStyle` accepts an omitted
version and adds it at the bridge boundary. For React, `style` configures the
inner chat; `containerStyle` and `className` only size and style the host container.
The DOM handle exposes `open(sessionId | null)`, `update({ title, ui, style })`
and `destroy()`; a null target selects the granted new-chat flow.

Raw CSS, selector injection and generated React Native Web class names are not a
styling API. Presentation overrides may hide attachments or a model picker but
cannot widen the grant. Attachment upload, retry and previews use the Session-bound
transfer owner. Arbitrary workspace-path and generated-file downloads are outside
the v1 contract.

### Session-bound attachments

Opening the OS file picker inside a standalone third-party embed frame is an
explicit Action-parity exclusion. Selecting local files remains a human UI
interaction; agents attach files through the existing attachment Actions instead.
The frame is not a recipient of connected-app reverse dispatch. This exclusion
does not add a frame recipient identity, extend `ComposerRef`, or change attachment
admission and transfer ownership.

`sessionAttachmentTransfers.ts` selects the Session-bound carrier supplied by the
current embed sync scope. It uses the existing encrypted Session RPC transport and
chunk/finalize/recovery owners, without acquiring a Machine carrier or Account
key. Ordinary Account uploads retain their Machine carrier.

The hosting Session registers only `session_attachment_upload_v1` uploads on the
existing eight `daemon.transfer.*` lifecycle methods. Their canonical RPC admission
is `session.message.send`; the daemon binds the upload to its real Session directory,
not a caller's `workingDirectory` or `workspaceRootPath`. Other upload kinds remain
unavailable in that namespace.

Finalization issues a strict `{ v: 1, sessionId, id }` attachment handle. The existing
`TransferSessionStore` retains the issued file association for the hosted Session's
lifetime. Message metadata and draft retries carry the handle unchanged. Previews
use `session_attachment_download_v1` with that genuine handle through the same
bounded preview sink/cache; arbitrary file paths and fabricated handles are refused.
The ordinary Account view can also preview these handles over its existing Session
RPC transport. Session disposal retires issued-handle authority and staged transfer
resources, without deleting successfully finalized files. Handles are process-local;
after the hosting Session is restarted, an old handle is unavailable.

## Validation and availability

Owner-level RED/GREEN checks establish specific contracts, not overall availability.
The approved composed journey must exercise plain and E2EE Accounts, host-side
authorization, creation/retry, key exchange, attachments, approval, switching,
refresh, revocation and an origin refusal on the loaded development stack.

`@happier-dev/embed` is a private workspace Developer Preview package. External
publication requires approval. A script-tag/npm-CDN example becomes actionable
only after publication; do not present it as an installation path beforehand.
Physical mobile browsers, cloud nginx headers after deploy, npm publication and
physical-device preview checks belong to the named release checks in the approved plan.
