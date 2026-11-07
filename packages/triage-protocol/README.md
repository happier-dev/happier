# `@happier-dev/triage-protocol`

`@happier-dev/triage-protocol` is the public, source-neutral V1 contract between
the `happier.triage` target and plugins that contribute Triage sources. It owns
the bounded schemas, contribution protocol, the two caller-bound source Action
references — administration and its read counterpart — and the conformance
helpers needed to declare a source. It does not own provider clients,
credentials, source materialization, host registries, UI, or persistence.

## Importing the contract

The package exposes explicit versioned entry points:

- `@happier-dev/triage-protocol` re-exports V1.
- `@happier-dev/triage-protocol/v1` exports the V1 schemas, types, contribution
  protocol, and both source Action references:
  `TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1`, which creates, reconfigures,
  removes and reactivates a configured source instance, and
  `TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1`, which lists the instances the
  calling contribution already owns. Three of the administration arms name a
  `sourceInstanceId` the caller must already hold, so a Settings surface needs
  the read Action to reach them. Administration remains the only configured-source
  lifecycle writer.
- `@happier-dev/triage-protocol/testing/v1` exports fixtures, conformance
  assertions, and the published byte-gate derivation
  (`buildMaximalSchemaValue`, `deriveMaximumEncodedBytes`,
  `deriveMaximumEncodedBytesByLabel`, `encodedJsonBytes`) for source-plugin
  tests.
- `@happier-dev/triage-protocol/ci/v1` exports hosted-CI identity, lifecycle,
  run, job, evidence, mounted-operation and 27 Action operand/result schemas.
- `@happier-dev/triage-protocol/ci/testing/v1` exports
  `createForgeCiConformanceVectorsV1`, including native attempts/steps and a
  GitLab pipeline without either optional capability.
- `/releases/v1` and `/releases/testing/v1` hold the separate release contract
  and its vectors. Existing root imports continue to export the source V1 ABI.

The CI and Releases additions describe 0.3 development-source Developer Preview
contracts, not an npm publication. Shared CI identities, states, annotations and
failure summaries are defined once in `@happier-dev/channels-protocol/v1` and
re-exported unchanged here; the remaining CI and Releases schemas stay in this
package. Provider clients, credentials, runtime controllers and UI remain outside
these protocol packages.

```ts
import { ForgeCiRunV1Schema } from '@happier-dev/triage-protocol/ci/v1';
import { createForgeCiConformanceVectorsV1 } from '@happier-dev/triage-protocol/ci/testing/v1';
const run = ForgeCiRunV1Schema.parse(createForgeCiConformanceVectorsV1().github.run);
```

Release consumers use the distinct release entry points and the same canonical
repository, failure, conditional-read, paging and file-download contracts:

```ts
import { ForgeReleaseV1Schema } from '@happier-dev/triage-protocol/releases/v1';
import { createForgeReleaseV1Fixture } from '@happier-dev/triage-protocol/releases/testing/v1';
const release = ForgeReleaseV1Schema.parse(createForgeReleaseV1Fixture());
```

These schemas confer no publication or filesystem authority. Provider Actions
and the host's current account, approval and opaque-destination admission remain
authoritative; an indeterminate write is not permission to replay it.

The development CI run projection carries optional `updatedAtMs` separately
from `completedAtMs`. GitHub maps `updated_at` without inventing completion.
For a completed run without an explicit end, shared CI duration presentation
uses `startedAtMs` → `updatedAtMs`, matching
[GitHub CLI's Run.Duration](https://github.com/cli/cli/blob/aee884dbcf96be3e4ea1e03ff1f33ae0b1f1aa9e/pkg/cmd/run/shared/shared.go#L121-L130).
Missing or reversed endpoints leave the duration unknown; unfinished runs do
not use update time. Jobs and steps retain native `completedAtMs` semantics.
This is a closed, unpublished V1 read projection; existing rows without the
optional fact remain valid, not a new mutation or capability authority.

Native steps may declare `timestampPrecision: 'second'` when their endpoints
have whole-second precision. Log attribution then covers both boundary seconds
in full, without changing the recorded start/completion facts or step duration.
Absent precision retains exact-millisecond intervals. Overlapping windows keep
all candidate step IDs; group markers describe nested output, not step identity.
GitHub emits this fact for whole-second step timestamps and preserves fractional
timestamps without widening. Tied timestamps alone cannot reconstruct the exact
step identities available in GitHub's separate per-step ZIP entries.

The 0.3 development CI read inputs and deployment approve/reject inputs accept
`credentialRef?: QualifiedConnectedAccountRef | null`, using the exact reference
from `@happier-dev/plugin-sdk/connected-accounts`. Omission or null preserves the
incumbent selection path, including native login. An explicit reference selects a configured Account;
it supplies no credential authority. Provider Actions declare the `credentialRef`
path through `connectedAccountPurposeBindings` and consume the host's admitted
binding. They must not replace a failed explicit selection with ambient login.
Other mutation and download inputs are unchanged.

The development CI `approveForkRun` operand includes the reviewed `headSha`,
`contributor` and `sourceRepository` alongside the exact run target. Take those
facts from the admitted run's `headSha` and `forkApproval`, without inventing
missing provenance. GitHub declares them as input fields for the host's single
confirmation and rechecks them against a fresh native run before approving.
Changed facts require another read and deliberate review, never an automatic
approval replay.

For a source plugin, import declarations from `/v1` and validate its manifest
declaration with the testing entry point:

```ts
import {
    TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1,
    TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
    TriageSourcesContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';
import {
    checkTriageSourceContributionV1,
} from '@happier-dev/triage-protocol/testing/v1';
```

A source Settings surface passes either ref to `hostApi.executeAction(...)`
unchanged. Both accept an optional exact admitted `source` address; it selects
the contribution and never supplies caller provenance. The host stamps the
caller independently. Plugin callers read and administer only their own source's
instances. Host agent/MCP/CLI callers can read all admitted sources or filter by
that address; create requires it, while lifecycle changes resolve the source
from the stored instance and refuse a conflicting address.

The conformance helper verifies the declared source contribution against the
public V1 contract. Installation, generation currentness, provider behavior,
and host admission remain owned by their existing host boundaries.

Account-only sources use `TriageSourceConnectedAccountInputsV1` from `/v1`
for their Action input schemas. These canonical specializations preserve the
role fields and require a configured account in every instance-bearing arm.
Native-capable sources use `TriageSourceCredentialInputsV1` and declare both
account and native-service selection paths. This specialization requires a real
credential selection in every input arm. Conformance accepts only the published
generic schema or its canonical account-only and credential specializations.

In 0.3 development source, a source reading the current authenticated Account's
data uses the generic input with the explicit Account-data binding. It needs no
Connected Account or native login. The source remains responsible for the
current Account's admitted data access on every invocation.

## Text search in scan (0.3 development source)

The existing scan input accepts an optional `query` on initial and continued
pages. A source can narrow its native read with that text; it keeps reporting
its actual partial, moving or finished coverage. The aggregate still applies
the shared text matcher and fold, so a source without native search may return
its ordinary bounded page. A continuation belongs to the query that produced
it and must not resume a different query.

This is the unpublished V1 author-contract direct cut, separate from package
SemVer. The scan input and its nested envelopes remain closed; omitted queries
retain ordinary scan behavior. Older strict source implementations can refuse
the new input through existing typed lane failures. No persisted format or
predecessor rollback adapter is introduced. See
[search ownership](../../docs/triage-sources.md#universal-search-03-development-source).

## Optional pull-request status (development preview)

Sources may bind the safe `readPullRequestStatus` role for a declared
`pullRequest` workflow kind. It accepts the existing exact-instance
`TriageGetInputV1` and returns `TriagePullRequestStatusResultV1`. The public
`TriagePullRequestStatusV1Schema` is the successful arm of that same closed
result, suitable for embedding in another admitted source read.

Check rows retain provider-established `required` evidence; missing or null
means unknown. Reviewer rows require a bounded source-native `id`, independent
of their display name or order. The existing merge object carries draft,
native state, queue requirements and membership, native auto-merge and viewer
capabilities when established. Branch evidence includes the observed head
revision. Unknown counts, partial reads and truncation remain explicit; an
empty list or conflict-free head does not establish readiness. Exact fields
and bounds remain owned by [the schema](src/v1/pullRequestStatus.ts).

An existing retained producer uses the public helper after successful ingress:

```ts
import { reconcileTriagePullRequestStatusV1 } from '@happier-dev/triage-protocol/v1';

const { value, checkedAtMs } = reconcileTriagePullRequestStatusV1(previous, next);
```

Pass `null` unless `previous` belongs to the same admitted Account, plugin
generation, configured source, credential, repository, PR and head. Equal facts
retain the previous status and nested identities; check/reviewer rows are keyed
by `id`, including across reorder. Only the enclosing `observedAtMs` is ignored
for semantic sharing. `checkedAtMs` always equals `next.observedAtMs`, even
when `value.observedAtMs` belongs to the retained object. Domain timestamps and
permission, head, failure or completeness changes still publish. A consumer
must retain the last successful clock on refresh failure and invent neither a
value nor a clock before first success.

This remains **0.3 development source** with automated/package and loaded-runtime
verification pending. The additions follow the undeployed source
[direct-cut rule](../../docs/compatibility.md#sdk-protocol-evolution); older
strict consumers are not assumed to accept the new shape. The shared Session Resource lifecycle and final header
composition are separate integration work. The optional role cannot conclude
entry absence or replace `get`/`scan`; sources that omit it retain their existing
entry details. See [source presentation and merge ownership](../../docs/triage-sources.md#detail-panels-and-cross-source-fix-links)
for the provider-owned Action boundary.

## Optional task writes (0.3 development source)

An optional `initialStatusId` in the create input selects an id from the place's
`taskCapabilities.initialStatuses` catalog of `{ id, label, state, isDefault? }`.
Optional `isDefault: true` identifies the entry used when `initialStatusId` is
omitted; without a marker the default is unknown to the caller. Omission
retains the source's default. A source advertises this catalog only when its
create handler applies the requested status in the same creation; invalid or
unsupported choices are refused before writing. No post-create transition runs.
The [public author example](../../apps/docs/content/docs/plugins/ui/index.mdx#initial-task-status-development)
shows the declaration. This additive unpublished V1 input remains closed and
requires matching development source, independently of package SemVer.

Sources may mark a kind as a task and bind optional `create`, `edit` and
`transition` roles to their ordinary named Actions. The same `/v1` entry exports
`TriageTaskCreateFieldsV1Schema`, `TriageTaskFieldsV1Schema` and
`TriageTaskWriteResultV1Schema`, the role inputs, capability declarations and
`triageTaskStatusCategoryV1`. Account-only specializations are included in
`TriageSourceConnectedAccountInputsV1`. Sources keep provider authorization,
native transition semantics and at-most-once settlement; an uncertain result
does not authorize a replay.

The entry snapshot carries optional live parent, children summary and blocked-by
facts. External sources do not persist a Happier copy of those relationships.
The existing state projection supplies mixed-view categories through the one
mapper; linked-agent activity remains a separate derived fact. See
[source ownership](../../docs/triage-sources.md#task-sources-03-development-source).

A source whose task record owns Session relationships may also bind optional
`linkSession` and `readSessionLinks` roles. The write uses the ordinary named
source Action and its remote-write approval; the safe read returns relationships
within the current Account and Home. Sources that omit these roles keep the
existing external-entry link path. The public role inputs and results are
exported from `/v1` beside the task write contracts.

## Evolving the ABI

Each explicit domain V1 subpath owns its wire epoch separately from package
SemVer; `/v1` and `/testing/v1` keep their existing source epoch. Keep shared source fields and schemas in this
package, and keep provider-specific implementation details in the contributing
plugin. Do not add `default`, `current`, `latest`, legacy, or compatibility
aliases. A breaking or independently-versioned shared contract requires a new
explicit versioned entry point rather than changing the V1 shape in place.
