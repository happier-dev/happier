# Triage Source Contributor

This advanced external-author example exercises a contributor-side
descriptor and embedded-renderer protocol shape against the canonical Triage
source contract (`@happier-dev/triage-protocol/v1`, protocol
`happier.triage/sources`). It is a specialist source example rather than a
starter template. It binds the target's public `detail` role to its local
renderer chain and the required `listInstances`, `scan` and `get` roles to
local Actions, without creating a target-owned destination or a second
renderer registry.

The paired target is `../triage-source-target`. Both examples import the
canonical versioned protocol through its public `/v1` subpath rather than
importing target implementation code or recreating the protocol schema.

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

## Referencing a Happier task

The 0.3 development contract also forwards the canonical Happier-task identity
helpers through the same public protocol. Use them when a source links to a
Happier task rather than parsing or constructing its owner scope locally:

```ts
import {
  INTERNAL_TASK_SOURCE_V1,
  internalTaskLocalRefV1,
  internalTaskOwnerAccountIdV1,
  isInternalTaskReferenceV1,
} from '@happier-dev/triage-protocol/v1';

const reference = {
  source: INTERNAL_TASK_SOURCE_V1,
  ...internalTaskLocalRefV1('task-42', 'owner-account'),
};
const owner = isInternalTaskReferenceV1(reference)
  ? internalTaskOwnerAccountIdV1(reference, 'viewer-account')
  : null;
```

Omitting the owner creates the existing personal alias, resolved against the
authenticated viewer. A qualified reference locates a task; it grants no
access. The host Task mutation owner resolves parent and blocker references
without requiring the caller to list unrelated task bodies for scope.
