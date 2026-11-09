# `@happier-dev/email-transports-protocol`

The email core (`packages/plugins/channel-email`) owns this public business
protocol for plugins contributing raw-mail transports to
`happier.channel.email/transports`. It contains schemas, types, role declarations
and conformance helpers. MIME parsing, sender trust, content shaping and
recipient decisions stay in the email core; network transport implementations
stay in their contributing plugins.

Use the explicit wire epoch and testing entrypoints:

```ts
import { EmailTransportsContributionProtocolV1 } from
  '@happier-dev/email-transports-protocol/v1';
import { assertEmailTransportContributionV1 } from
  '@happier-dev/email-transports-protocol/testing/v1';

const roles = EmailTransportsContributionProtocolV1.operations;
```

Contribute to the email plugin's `transports` point with arbitrary same-plugin
Action ids bound through `roles.listSince.bind(...)`, `fetchRaw`, `submitRaw`
and `connectionTest`. `findSent` is optional. Derive each Action's input schema,
result schema, surfaces and danger level from the corresponding role's
`declaration`. `assertEmailTransportContributionV1(manifest)` checks those
declarations through the public SDK manifest parser. It checks every transport
contribution in the manifest and does not certify installation or runtime availability.

In current development source, `listSince(null, ...)` establishes a baseline:
return no references and the current high-water checkpoint. After `historyGap`,
the same null-checkpoint call establishes the replacement baseline; it does not
import mailbox history. A non-null checkpoint returns subsequent arrivals.

`fetchRaw` returns `{ kind: 'raw', mimeBase64, receivedAtMs }`. The receipt time
must come from immutable transport evidence for that message (IMAP
`INTERNALDATE`, for example), and must remain identical when the reference is
replayed. In current development source, the email core uses this receipt time
for occurrence admission and retention. A valid message `Date` header remains
the authored `message.providerTimestamp`, with receipt time as its fallback.
A poll or fetch invocation time is not a receipt time.

V1 keeps protocol identity `happier.channel.email/transports`, version `1`.
Serialized protocol identity and executable validation establish interoperability
between separately installed package copies. Package versions and wire epochs
are independent; the root explicitly re-exports V1. Follow the canonical
[SDK protocol-evolution doctrine](../../docs/compatibility.md#sdk-protocol-evolution).

## Release posture

This package is development source for Developer Preview authoring. It has not
been published by this change. External publication is owned by release
automation and requires explicit approval.
