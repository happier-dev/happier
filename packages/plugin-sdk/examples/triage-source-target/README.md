# Triage Source Target

This advanced external-author example exercises a target-side
descriptor and embedded-renderer protocol shape against the canonical Triage
source contract (`@happier-dev/triage-protocol/v1`, protocol
`happier.triage/sources`). It is a specialist source example rather than a
starter template. The public roles remain target-owned: this package stops at
declaration and observation, without selecting a contributor, owning a
renderer, creating a destination, or mounting UI.

The paired contributor is `../triage-source-contributor`. Both examples import
the canonical versioned protocol through its public `/v1` subpath; neither
package imports the other plugin or host-private schema.

Build, typecheck, test, and pack this package through the normal managed
source-author commands; the declared `@happier-dev/triage-protocol` dependency
resolves through the running CLI's prepublication closure:

```sh
hdev plugins dev typecheck .
hdev plugins dev build .
hdev plugins test .
hdev plugins pack .
```

This proves the public Developer Preview source-contract authoring surface
while SDK and protocol publication remain pending. The aggregate
source-mapped SDK fixture stays the authoring-inference verification, and
loaded-platform and release availability remain separate evidence recorded by
the capability matrix.

For a mounted search, filter retained rows immediately and schedule only the
remote read with the development SDK's shared Universal Search debounce:

```ts
import { scheduleSearchQuery } from '@happier-dev/plugin-sdk/async';

let cancelPendingSearch: (() => void) | undefined;
function queryChanged(query: string) {
  cancelPendingSearch?.();
  cancelPendingSearch = scheduleSearchQuery(() => readRemote(query));
}
```

Here `readRemote` is the target's existing scan entry; cancel the pending callback
on disposal and abort an in-flight read through its existing cancellation owner.
The helper shares Universal Search's default delay rather than naming another
duration. This is current development source; generated API records and loaded
host validation are separate availability evidence.
