# Happier embed

Mount the real Happier conversation view in a web application's own layout.

## Release posture

Development preview, currently unpublished. External publication requires approval.
The host package requires Happier's embed bridge V1. The package version and wire
epoch evolve independently. Protocol owns its executable validators in
`packages/protocol/src/embed`; [protocol evolution](../../docs/compatibility.md#sdk-protocol-evolution)
governs this seam. Identity, credential, routing, events and envelopes are closed;
colour records are additive presentation data. Unknown bridge fields are rejected.

```ts
import { mountHappierSession } from '@happier-dev/embed';

const chat = mountHappierSession(document.getElementById('chat')!, {
  happierUrl: 'https://cloud.happier.dev',
  sessionId: lead.sessionId,
  title: 'Lead conversation',
  getCredential: async (request) => {
    const response = await fetch('/api/happier/credential', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error('Credential unavailable');
    return response.json();
  },
});
chat.open(otherLead.sessionId);
chat.update({ style: { v: 1, radius: 'soft' } });
chat.destroy();
```

Give the container an explicit height. Omit `sessionId` to open a new chat when the
embed's grant and configuration permit it; `open(null)` starts a fresh new chat.
The backend must authorize the signed-in user's access before minting credentials,
including creation attribution for requests with `reason: 'created'`.
`getCredential` may return the exact SDK-issued result including `tokenId`; that
validated attribution field is not forwarded in the private bridge credential.

React applications use `HappierSession` from `@happier-dev/embed/react`. Its props
match the mount options, with `className` and `containerStyle` for the outer box.
`style` configures the inner chat's theme tokens; CSS injection is not supported.
Prop changes update the mounted frame. React StrictMode cleans up its probe mount.

`onSessionCreated({sessionId})` reports a creation fact. A successful ready state
activates that session only while the requested target is a new chat. A later
creation result cannot replace a lead selected with `open()`.

Credentials and sealed envelopes stay in memory and cross to the exact Happier
origin over a private message port. Links may open another tab; the iframe receives
no permission to navigate the containing page. `destroy()` removes its listener,
port and frame and drops pending credential results.

The credential-serving backend and active host-page code are trusted. The normal
handoff passes sealed blobs through the page, but an authorized hostile host script
can request credentials sealed to its own public key and open the Session key and
options. The complete setup and trust boundary are documented in
[embed architecture](../../docs/embed.md).

## Development API records

`prepare:api-governance` and `check:api-governance` route compilation through the
managed executor. `api-governance` writes source records locally from fresh emitted
declarations. When preparation runs remotely, return the ignored package declarations
and their bundled protocol declaration closure before running that local writer;
remote execution does not copy `dist` back automatically. Do not generate records
from an older local build.
