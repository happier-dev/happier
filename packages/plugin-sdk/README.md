# `@happier-dev/plugin-sdk`

The public authoring contract for Happier plugins. It covers cold manifests,
daemon activation, invocation services, native Agent runtimes, Plugin UI, UI
builds, and the plugin testkit.

The [public authoring example](examples/public-authoring/README.md) demonstrates
0.3 development-source localized labels with scalar `params` and the public
`/manifest` text resolver. The [manifest guide](../../apps/docs/content/docs/plugins/manifest/index.mdx#localized-labels-03-development-source)
describes fallback behavior and older-host compatibility.

## Durable native-tool data (0.3 development source)

Daemon invocations can call `context.services.fs.getPluginDataDirectory({ relativePath: 'my-configuration/native-state' })`
to create or reopen a directory beneath the plugin's existing `pluginData` root.
The returned absolute path works in Exec arguments and refers to the same bytes as
logical `pluginData` file operations. Invocation disposal leaves this data in place.
Use separate relative paths for configurations that need independent native state;
this accessor does not create another storage root or a background service.

## Native SQLite reads (0.3 development source)

Daemon plugins use `openSqliteDatabaseSync` from `@happier-dev/plugin-sdk/fs` to
select the host's Node or Bun SQLite implementation. Open user-selected existing
files with `{ readOnly: true }` when reading them, and close the database when the
owning operation or demand ends.

Use `columns()` and `values()` when result order matters:

```ts
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';

const database = openSqliteDatabaseSync(selectedExistingFile, { readOnly: true });
try {
    const statement = database.prepare('SELECT id AS value, label AS value FROM records WHERE id=?');
    const columns = statement.columns();
    const rows = statement.values(9223372036854775807n);
    // columns retains both labels and declared types even when rows is empty.
    // Each row is positional; native INTEGER values remain bigint.
} finally {
    database.close();
}
```

Expression columns can have a null declared type. SQLite values retain their
native storage class, which can differ from a column's declared affinity.
Existing `get()`, `all()` and `iterate()` calls keep their object rows; `run()`
keeps its affected-count result. Matching 0.3 development hosts provide the added
statement methods.

## Packaged Bot templates (0.3 development source)

Declare cold releases with `botTemplates: { researcher: { path: 'templates/researcher.json' } }`
in `definePlugin`. Each path names packaged JSON containing the canonical BT2
`BotTemplateReleaseV1`, unchanged. A plugin can declare several templates;
each contribution has its own local id. Paths use portable `/` separators and
stay inside the package. Include those files in the package's published files.

The manifest projects these entries as `contributes.botTemplates: [{ id, path }]`.
They require no registration callback or activation. The selected-package reader
supplies registry provenance separately; the authored JSON contains neither a
private draft id nor an attestation of its source. Generic `resources` with
`kind: 'template'` remain a separate contract. This development descriptor requires
a matching host; consult the generated capability matrix for product availability.
See the [multiple-template public fixture](examples/public-authoring/botTemplates.ts).

## Theme contributions (0.3 development source)

Declare one or more portable themes with
`definePlugin({ themes: { paper: { theme: profile } } })`. The manifest contains
`contributes.themes: [{ id: 'paper', theme: profile }]`; the profile follows the
host's canonical theme format. This is data only: listing or selecting a theme
requires no activation callback or executable entrypoint. See the maintained
[theme authoring example](examples/public-authoring/themes.ts).

Installed themes retain their plugin's qualified identity. They are read-only;
Duplicate creates an independent editable theme in your library. Removing the
plugin withdraws its themes, while duplicates remain. A missing selected plugin
theme renders the base theme without rewriting the saved selection.

Mounted UI receives the active theme through the existing context channel.
The optional `theme.sanitizedCss` contains the host sanitizer's completed web
stylesheet; the hosted client applies and retires it with that context. Native
presentation consumes the optional mode-resolved `theme.surfaces` table. Authors
use the shared primitives rather than compiling or attaching a second theme.

This requires matching 0.3 development hosts; older strict manifest readers may
reject the new contribution family. Check the generated capability matrix for
current availability. Theme CSS coverage is reported by the host, including
rules that apply only on web and desktop.

## List extensions (0.3 development source)

Use `ui.listExtensions: { localId: { entity, filterFields?, rowMark? } }` in
`definePlugin`. The manifest uses the same closed declaration as Protocol;
`PluginCollectionListExtensionV1` is exported from `@happier-dev/plugin-sdk/ui`.
Fields use the existing public scalar/set/time evaluator over held facts.
`rowMark` names a declared same-entity field and chooses `context` or `mark`;
its reference is qualified by the host projection. Ordinary Actions provide
row operations through their existing placements and Session operands.
Declaration admission and matching do not activate the plugin or read a
Resource. Resource-backed host-row loading remains deferred. See the maintained
[external author fixture](fixtures/external-targeted-packages/list-extension-source.ts)
and [collection ownership](../../docs/collection-presentation.md).

## ACP permission presets (0.3 development source)

ACP permission presets in 0.3 development source accept ordered native-mode
candidates, for example `permissionModeMapping: { 'safe-yolo': ['review-auto', 'review-code'],
'read-only': ['review-ask'] }`. The host chooses the first candidate in the opened
Session's advertised modes and refuses configuration when none match. A string
keeps the existing fixed-mode behavior; `null` deliberately retains the native
policy and does not establish enforcement for a retained Run input. Launch-time
`permissionModeArgv.map` values remain strings or `null`, since launch precedes
Session advertisement. See the maintained
[public ACP author example](examples/public-authoring/agent/runtime.ts) and
[SDK compatibility doctrine](../../docs/compatibility.md#sdk-protocol-evolution).
This authority-bearing declaration requires the matching development host;
older strict hosts reject unsupported shapes.

## Pinned fresh clones (0.3 development source)

Fresh-clone authors targeting matching 0.3 development hosts can request a
reviewed `main` commit through `ScmRepositoryCloneInput.initialCheckout`.
See the [typed clone example](../../apps/docs/content/docs/plugins/api/actions-tools-commands.mdx#pinned-fresh-clones-03-development-source)
for publication and partial-outcome semantics. This is separate from changing
the branch of an existing checkout.

The same owner accepts `{ branch: 'feature/name' }` to select a remote branch
before publication. Optional `authentication: 'connected_account'` requires the
hosting provider's private, purpose-bound credential materialization. Credential
bytes stay in the controller and are never part of the clone result or target
process environment. Matching hosts provide `repositoryTransport` for binary
smart HTTP over their workspace process boundary; target Git sees only a
credential-free, operation-local URL rewrite. Target push and branch publication
consume the same transport. Matching hosts
also supply `BackendRuntimeServices.repositoryFileSystem` so destination effects
use the same workspace source as Git; a bound host without it reports unavailable.

## Coalesced reads (0.3 development source)

`createCoalescedScheduler` from `@happier-dev/plugin-sdk/async` owns one active
drain. `trigger()` and `flush()` queue one follow-up when called during it.
When another consumer needs the read already in progress, use
`await scheduler.flush({ ifRunning: 'join' })`: it waits for that same cycle
without requesting another drain. When idle, it starts a read normally.
Explicit refresh or changed inputs can still use ordinary `flush()` or
`trigger()` to request fresh work. The helper owns no timer or retry policy.

## Public SDK release posture

The SDK has one package-level **Developer Preview** source contract. The
workspace package remains `private: true` at `0.0.0` and is unpublished while
the publication gates are open. No public version or released-semver policy is
established by the current source tree, and a workspace build must not be
presented as a published SDK.

The author API and `/testing` remain public. The retired `/host/*` and
`/first-party/*` subpaths are not exported; host implementation stays private,
and bundled Agent and Provider facts come from their canonical Protocol owners.

Developer Preview is not a per-symbol stability tier. The publisher-generated
API inventory is the public census and retains publication-derived `@since`
metadata; structured deprecation remains separate. The generated
`capability-matrix.json` is the availability authority. Source exports,
examples, host wiring, source tests, and loaded development-stack lifecycle QA
establish feature readiness.

In 0.3 development source, declare an operation once under `actions`. Its
optional `tool` metadata gives it a named Agent/MCP presentation, and `cli`
metadata gives it a friendly command path; select those invocation surfaces on
the same Action. Separate `tools` and `commands` families are retired and
strict authoring rejects them. See the
[Action author guide](../../apps/docs/content/docs/plugins/api/actions-tools-commands.mdx).
Loaded development-stack evidence may still be `not-recorded`; that is an
evidence status, not source unavailability. Public registry release is a separate publication
boundary, and this workspace README does not claim that release or loaded
validation. Preview status does not waive correctness, installability,
lifecycle cleanup, security disclosure, examples, or documentation.

## Discussion invalidation (0.3 development source)

Plugin UI can observe one Discussion through the existing Resource lifecycle:

```ts
const reference = { hostRead: 'discussion.get', input: { discussionId } } as const;
const watch = await host.watchResource(reference, () => refresh());
// Release the observation when its consumer closes.
await watch.dispose();
```

Native and hostedWeb use the same admitted host read. Its JSON snapshot contains
only `discussionId` and an observation `revision`; invalidation events contain
only the Resource digest. Read content through the ordinary Discussion Actions.
The current plugin caller, captured Account and Discussion access still apply;
an unavailable target or retired mount cannot establish a watch. Older hosts
refuse the unsupported reference through their existing typed result.

Daemon plugins can subscribe to `@happier/session/discussion-invalidated` with
`scope: { kind: 'account' }` through `context.services.events.host`. Its closed
payload contains a Discussion ID and an optional revision, never authored
content. Both observations consume the existing Account change producer. They
are lossy refresh hints, not a replay log or an exactly-once delivery promise.
This is an unpublished Developer Preview source contract; loaded-runtime
verification is separate.

## Fresh Artifact reads in feature handoffs (0.3 development source)

An Artifact id carried by a handoff identifies what to read; it does not grant
access or prove the stored source is current. Re-read through the ordinary host
Action before acting on its content:

```ts
import { ProtocolArtifactGetOutputV1Schema } from '@happier-dev/plugin-sdk/protocol';

const read = ProtocolArtifactGetOutputV1Schema.parse(
  await host.executeAction('artifact.get', { artifactId }),
);
if (read.artifact === null) return;
// The feature still admits the exact source, target, audience and revision.
```

This composable value projects the host Action's existing parser. It does not
create a second Artifact reader, bypass Account admission, or authorize a
Session or service mutation. This is an unpublished source API; loaded handoff
validation is separate.

The development `/protocol` entry also projects the deployment owner's exact
Artifact id/revision/kind/JSON reader, protected preview provenance and receipt
SourceIntent parsers. See the [deployment Artifact author example](../../apps/docs/content/docs/plugins/api/actions-tools-commands.mdx#exact-deployment-artifact-reads-03-development-source).
These selected-field readers neither authorize an operation nor prove a preview
URL or current Source association; the host domain owners still admit those facts.

## Voice presentation (0.3 development)

In the 0.3 development Voice contract, `VoiceProviderSettings.privacyFacts`
declares localized `audioDestination`, `processor`, `retention`, and optional
`details`. `VoicePrivacyFacts` is available from `/voice`. The host presents
these facts only in Settings → Voice → Privacy & data, with the existing full
`privacyDisclosure` behind Details. Declare the actual service policy; do not
infer retention or training guarantees from a service name.

Contributed numeric settings can request the host's shared stepper with
`numericControl: 'stepper'`, an explicit positive `step`, existing setting bounds,
and optional localized `unitKey`. This changes presentation, not saved values.
See the [Voice guide](../../apps/docs/content/docs/plugins/guides/voice.mdx).

## Managed-machine provisioners (development source)

Managed-machine provisioners are available in development source through the
descriptor-only `machineProvisioners` author input and the public
`@happier-dev/plugin-sdk/machine-provisioners` schema constructors. Bind their
roles as ordinary daemon Actions; the host owns selection, retained credentials
and effect admission. Pending acquisitions declare a native-operation schema and
safe reconciliation Action through the same ABI. Persistence-only readers use
the same canonical tolerant projection; strict Action inputs and writes remain
separate.
Reconciliation only reads retained immutable submission facts or the returned
native identity. It must never allocate or replay a submission, even with an
idempotency key. If a read cannot recover the identity, return `unknown` with
recovery information so the host retains the same uncertain row. The public
author fixture demonstrates both retained-handle and correlation-only uncertainty;
schemas validate results but cannot prove arbitrary plugin IO is read-only.
Safe prerequisite checks may describe a qualified repair Action and its input;
they do not run repairs or grant installation permission.
Options return a `base` launch and independent `dimensions` arrays for size,
image, location, network and duration. Each option declares its selector
`assignments` as launch paths and JSON values. Native adjacency constraints and
price `when` selectors refer to returned dimension option ids, without expanding
every combination. Use `projectMachineProvisionerSelectionV1({ options,
selection, launchSchema })` from the same entrypoint to obtain the selected facts
and applicable prices; only `kind: 'ready'` carries a closed-schema-validated
launch. Missing base or selections remain incomplete, and unavailable or invalid
selections cannot execute. A Devcontainer effect review remains bound to its
unchanged reviewed base launch. Declare finite-only retention explicitly; native
expiry is a separate fact, and omitted measurements remain unknown.
Declare optional `enrollmentRole: 'server' | 'personal' | 'sandbox'` on the
provisioner and `guestPlatform: 'linux' | 'darwin' | 'windows'` on an
options base or dimension entry when the guest OS is known. An image option can
carry that fact beside its image presentation; the shared selection projector
retains the selected platform. An options base or dimension entry may also supply
`enrollmentRole`, whose selected value overrides the descriptor role. Descriptor
`platforms` names supported controller OSes, which may differ from the guest OS.
A declared Linux server drafts the
dedicated `happier` user-service with editable Preauthorized administrator access;
personal uses the existing user and sandbox uses the guest process. Missing role,
or a server without platform facts, keeps the personal-user default. A declared
macOS/Windows server keeps that path with an unsupported dedicated-user
explanation. Explicit reviewed identity is preserved, and bootstrap still checks
actual host capabilities.
See [declaration and activation ownership](../../docs/plugin-platform.md#declaration-activation-and-projection)
and the [public author fixture](fixtures/authoring-inference/machineProvisioners.ts).
This is not a registry-publication or loaded-runtime readiness claim.

## Backup destinations (0.3 development source)

The development `backupDestinations` descriptor seam uses recursively closed
nonsecret configuration, canonical credential roles, restic transport/locality
facts and qualified `test` / `open` Action refs. The maintained
[`backupDestinationAuthoring` companion](examples/public-authoring/index.ts)
uses public exports and ordinary Action activation; both example Actions return
an explicit unavailable result and perform no native transport work. See its
[authoring notes](examples/public-authoring/README.md) and the
[contribution guide](../../apps/docs/content/docs/plugins/manifest/contributions.mdx#backup-destination-declarations-03-development-source).
Native transport and backup configuration lifecycles are not supported yet;
descriptor admission does not establish backup or restore support.

## Plugin execution targets (0.3 development)

Plugin UI is discovered across the Account's installed machines. Declare
`executionTarget: { default: 'installation' }` in `definePlugin` or the manifest
to prefer the supplying installation for machine-bound work. The host admits
that hint against current installation and source facts. An explicit user choice
takes precedence and an unavailable saved choice is never silently replaced.
Otherwise the host automatically picks an online admitted Machine after the
Home's Machine list settles, preferring the rendered release's version, last
use on this device, this device's own Machine when known, then recent activity.
An unavailable automatic choice can be picked again. Declare
`executionTarget: { autoPick: false }` when the work requires an explicit Machine
choice: a sole eligible candidate still auto-selects, while several candidates
ask. The installation hint can share that object. Machine-free UI
requires no execution target. Invocation revalidates the exact selected
materialization or source occurrence, while installation administration and
Session-native work retain their own targets.

`SurfaceContext.targetedContributions` is optional: static, machine-free UI can
render without a runtime occurrence. Absence does not admit private machine
operations or manufacture a targeted contribution snapshot.

### Hosted UI compatibility (0.3 development)

The current SDK requests semantic Host API 1.1 within wire epoch 1. Declare an
Artifact `hostUiApiRange` that includes the API your code needs; 1.1 introduces
`actionControl` and `openManagedMachineConfiguration`. A 1.1 wire negotiation
request reaching a 1.0-only Host API is refused with `incompatible_api_version`.
An older host's injected single-range controller may refuse locally instead,
surfacing `transport_unavailable`; its precise reason is not covered by that
direct-wire guarantee. Current hosts continue serving
installed 1.0 SDKs with their exact 1.0 reply and supported method set, including
when the host's presentation client uses 1.1 in the same document. A successful
negotiation still reports only methods the mounted host can actually serve.
Its method list describes that client's semantic generation; it is not a
permission grant. The shared document still admits only its installed,
transport-supported, mount-allowed operations, independent of which sibling
SDK negotiated last. The SDK itself uses its negotiated method list before
issuing a call.
The shared guest also projects context presentation for that negotiated
generation: installed 1.0 readers omit the later optional theme `statusTint`;
current clients retain it. Resource values and mount/Account authority are
unchanged.

## Automation Event authoring (0.3 development source)

`host.openAutomationEvent({ eventRef, setupInput, monitoringMachineId?, connectedAccount? })`
opens Happier's existing Event editor in the Account trigger form. `setupInput` contains
the selected Event's declared setup Action operands, such as a repository. The qualified
Connected Account, when supplied, seeds that Action's account field; a contradictory account already
present in `setupInput` is rejected. Opening configures and saves nothing. The person
explicitly chooses any omitted monitoring Machine through the existing watcher chooser
and any omitted account through the setup Action form, then reviews source setup and
completes the existing trigger form's Runs on and Then choices. Opening is not enabling monitoring.
This method requires the active Account and an installed negotiated host handler; hosts
without it return the existing typed unsupported result. See
[the host ownership contract](../../docs/plugin-platform.md).

## Project pages (0.3 development source)

An external plugin can contribute a Project destination with the existing
`appPage` surface family:

```ts
defineUiSurfaceDefinition({
  id: 'project-review', placement: 'appPage', target: { kind: 'project' },
  title: 'Project review', description: 'Review this Project.',
  renderer: { kind: 'reactNative' },
});
```

Use the renderer shape advertised by your generated SDK. Omitting `target`
keeps the existing app-page meaning; `settingsPage` remains app-only. Project
pages support the same page metadata, while columns, app-rail placement and
personal widget areas remain app-target-only. Raw `ui.views` uses
`container:'appPage', target:{kind:'project'}`. Optional applicability uses the
ordinary `availability.when` expression with `project.repository.kind`.

For an Overview widget in unreleased 0.3 source, use
`placement:'widget', target:{kind:'project'}` with a required `sizeDeclaration`
through `defineUiSurfaceDefinition` (raw Views use `container:'widget'`).
The same optional repository applicability is preserved. The host's existing
Project widget area supplies the admitted Project context; do not add a
Project-id input or reconstruct it from launch input. This is a generic plugin
surface, separate from the app-only personal widget-area declaration above.

Read the host's accepted `surface.target.projectKey`, optional qualified
`source`, `checkout`, `repository` and observed `branch`; a route's Workspace reference id is a
checkout address. Rendering does not require a Run-on selection. Use
`replacePageLocation(subPath, {backLocation})` for local detail/page/return
navigation. The host owns qualified URLs and ephemeral launch input.
Contextual dynamic Resource producers receive the same admitted target through
`options.context.target`, even for an unopened tab badge. Session targets also
carry optional `repository`, `branch` and `headOid`; unknown facts are omitted.
Use these facts instead of launching a checkout probe. Declare one ordered
labelled binding with `counts:{resourceId,items:[{field,label}]}` on a Project
page or sidebar destination. Its one JSON Resource returns exactly those field
names with nonnegative integer or `null` values. Labels belong to the declaration;
malformed records stay wholly unknown, and legacy scalar `countResourceId`
cannot be combined with `counts`.

Producer tests in unreleased 0.3 source can import
`createTestResourceInvocationContext` from `@happier-dev/plugin-sdk/testing`:

```ts
const options = createTestResourceInvocationContext({
  context: { kind: 'session', sessionId: 'session-1' },
  signal: controller.signal,
  accountStorage,
});
const observation = await resource.observe(invalidate, options);
try { await resource.read(options); }
finally { await observation.dispose(); }
```

Omitted context and signal use a global context and a fresh lifetime. Host
services are unavailable unless supplied: `readAction` returns an Action failure
envelope with `plugin_test_service_unavailable`; Resource I/O and `observeAction`
throw or reject `PluginError` with that code. Pass `resources`, `readAction`, and
`observeAction` overrides when the test exercises those host boundaries. This
builder does not simulate host admission or install a successful empty watch.

In unreleased 0.3 source, a daemon dynamic Resource can optionally provide
`createProducer({signal, context, readAction, observeAction})` when its read and
observe callbacks need one shared owner. Return `{read, observe, dispose}`; the
factory signal belongs to the admitted Resource context, not its first read.
Individual callback signals still cancel only their own invocation. The host
retires the producer with that context and disposes late factory results.
This is daemon-only: unsupported placements reject it, and required direct
callbacks must fail explicitly if they cannot provide the same lifetime.
Use the existing read-only Action ports for dependencies; do not create another
credential watcher, request registry or polling owner.
See the [public example](examples/public-authoring) and
[Project page recipe](../../apps/docs/content/docs/plugins/ui/configuration-pages.mdx#project-pages).
This is a Developer Preview source contract, not a publication or loaded-runtime
verification claim.

## Portable Account Actions (0.3 development)

Use Account placement for portable Action code that must run in the invoking
UI or CLI without a Machine. It is not implied by Account-scoped data or UI:

```ts
import { definePlugin, PluginError } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';

const inputSchema = defineProtocolObject({ key: defineProtocolString() }, { policy: 'closed' });
const plugin = definePlugin({
  id: 'acme.personal', version: '1.0.0',
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: { required: [{
    id: 'account-storage', capability: 'storage.account',
    reason: 'Read personal values in this Account.', scope: { enabled: true },
  }], optional: [] },
  actions: {
    read: {
      title: 'Read personal value', surfaces: ['ui', 'cli', 'agent', 'plugin'],
      placementBindings: [], dangerLevel: 'safe', inputSchema,
      hostAccess: ['account-storage'],
      execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } },
      run: async ({ key }, context) => {
        const entry = await context.services.storage.account.kv.get(key, { signal: context.signal });
        return { value: entry && !('deleted' in entry) ? entry.value : null };
      },
    },
  },
});
export const manifest = plugin.manifest;
export const activate = plugin.activateAccount;
```

Export that module as `./happier-plugin-ui/account-runtime` in `package.json`.
It is the portable entry, not the package-root daemon entry: the root exports
`plugin.activate`, while the portable entry exports `plugin.activateAccount`
as `activate`. Ordinary authoring and packaging evaluate the root with daemon
registration rights, which do not admit Account handlers.
KV readers and writers require the declared Account storage grant. The fixture's
pure `echo` and `source` Actions leave `hostAccess` omitted and do not use storage.
Optional storage declarations do not grant access.
The existing portable-artifact compiler rejects Node builtins. Account handlers
receive Account storage, ordinary host Action execution and admitted targeted
contributions, not Machine services or UI navigation. When several artifact/export
pairs exist, wrap `activateAccount(api, { artifactId, exportName })` for each exact
entry; the host grants only its manifest-declared registration rights.

In the CLI realm, the same Account context also projects the existing admitted
HTTP and declared-secret services. Both members are optional because portable
UI execution omits them. Narrow their availability before use:

```ts
const { http, secrets } = context.services;
if (!http || !secrets) {
  throw new PluginError({ code: 'controller_services_unavailable', message: 'CLI Account services are required' });
}
const status = await secrets.status('declared-token');
```

An admitted controller invocation may supply optional
`services.machineConnectorSecrets.write({ token, subject: { provider, connectorId } })`.
Mint or retrieve the token inside the Account handler and pass its bytes directly
to this sink. The host captures the controller, target Machine and installation,
receiver public key and admitted operation; these are not plugin operands.
Only the opaque `{ grantRef }` leaves the handler. Zero caller-owned bytes in
`finally`. The sink is absent without that admitted controller invocation,
including portable UI execution. Do not retain it, return the token, store the
token as a Saved Secret, or retry an uncertain write. The maintained
[controller connector fixture](fixtures/account-actions/src/index.ts) shows this
development-source flow.

Declare HTTP origins/methods and secret identifiers through the ordinary
manifest owners. This projection supplies no filesystem, Exec, raw credential
reader, or alternative execution Machine. HTTP JSON secret placeholders use
the existing [secret custody contract](../../apps/docs/content/docs/plugins/services/secrets.mdx#use-a-shared-reference-in-an-http-body).
An Environment operation retains its selected controller when that Machine
is offline; its relay reports `machine_unavailable` with `role: 'controller'`.

The current enabled Account release (or trusted host-bundled declaration) is
the custody authority. Ordinary enablement, schema validation, policy, approval,
cancellation and currentness checks still apply. Do not retain invocation-bound
services for later work, retry an uncertain write, or treat a source descriptor
as permission to execute on a Machine. Controller placement remains an explicit
parent-operation decision, independently of portable personal sources.
See the [public fixture](fixtures/account-actions/src/index.ts) and
[platform owner](../../docs/plugin-platform.md#portable-account-actions-03-development-source).
This API is 0.3 development source; verify generated API/toolchain compatibility
before targeting a published host.

## Cross-plugin protocol authoring

### ACP steering codecs (0.3 development source)

An Agent factory can contribute `definition.delivery.steer` when opening the
shared ACP composer. The codec selects a native method and builds its parameters;
the host keeps admission, turn ownership, input custody, and transcript writes.
`isSupported(agentCapabilities)` can require the Agent's advertised extension.
Return `null` from `buildParams` for inputs the native method cannot represent.
The host refuses these before writing. `isAccepted` proves consumption;
`isRejected` proves a refusal safe for the existing retry/resend flow. A reply
that proves neither leaves custody unknown. An explicit refusal never ends the
containing turn.

```ts
import type { AgentAcpInFlightSteerDefinition } from '@happier-dev/plugin-sdk/agents/runtime';

const steer: AgentAcpInFlightSteerDefinition = {
  method: 'example/steer',
  isSupported: capabilities => capabilities !== null && typeof capabilities === 'object'
    && !Array.isArray(capabilities) && capabilities.steering === true,
  buildParams: ({ providerSessionId, inputIds, input }) => ({
    sessionId: providerSessionId, inputId: inputIds[0], text: input.text,
  }),
  isAccepted: result => result === 'absorbed',
  isRejected: result => result === 'dropped',
};
```

These callbacks require the matching 0.3 development host under the direct-cut
ruling below; older hosts cannot safely ignore capability or custody decisions.

Use the [SDK protocol-evolution doctrine](../../docs/compatibility.md#sdk-protocol-evolution)
whenever an SDK author surface, Host Event, or cross-plugin business protocol
changes. A wire epoch is semantic and independent from an npm package version;
an optional input is safe only if an older implementation can ignore it without
claiming false success. New union members are safe only for explicitly skippable
bounded presentation lists—not identity, authority, presence, permission,
pagination, retry, or mutation-outcome unions.

Independently published business protocols use any valid scoped or unscoped npm
package name ending in `-protocol`, with explicit `/v1` and `/testing/v1`
exports. The npm scope identifies the package author; it does not grant
additional protocol authority.
They contain schemas, types, helpers, and conformance fixtures, but no host
runtime, persistence, provider implementation, credential materialization,
polling, private `@happier-dev/protocol` dependency, or floating
`latest`/`current`/`default` alias. Compatible copies use serialized protocol
identity/version and runtime validation, not JavaScript object identity. Each
feature-protocol package keeps a short README and nearest `AGENTS.md` that name
its domain owner and link to the doctrine rather than reproducing it.

## Cross-plugin contribution authoring

Use a **cross-plugin contribution protocol** when a target plugin admits
specific existing Actions from another plugin through named operation roles. The
host owns admission, currentness, observation, and execution; a contributor
neither self-registers nor gives the target a callback, Action scan, or second
dispatcher.

Ordinary target and contributor packages import the feature-owned protocol
value. For example, a Channels target calls
`ConversationProvidersContributionProtocolV1.point()`, while a provider calls
`.contribute()` and binds its arbitrary local Action ids through
`protocol.operations.<role>.bind(localId)`. The operation's immutable
`.declaration` supplies the role's input mode, result schema, Action surfaces,
and danger level; do not copy them into a second map or read them back from a
raw manifest. A contributor-defined input remains the contributor's own Action
schema.

Descriptor, operation, and embedded-surface roles are public authoring contracts.
The target reads its own admitted snapshot with
`context.services.targetedContributions.observeForSelf(...)`, then renders a
returned surface through React `TargetedSurface` or the protocol role's
declarative `.node(...)` helper. Those are two authoring forms over the same
host surface owner, not separate renderer or currentness paths. The
[cross-plugin contribution guide](../../apps/docs/content/docs/plugins/guides/cross-plugin-contributions.mdx)
shows both forms.

In 0.3 development source, resume a host-selected operation with
`selectCurrentTargetedContribution({ ..., operationRole: '<declared role>' })`.
For mixed placements, the selection retains that exact role's custody, which
can differ from the parent descriptor or another role. A replaced or missing
selected role is unavailable; a sibling role cannot renew its authority. The
default selector still matches the parent contributor when no role is supplied.

Only a reusable feature-protocol package imports the cross-plugin constructors
`defineContributionProtocol` and `defineContributionPoint` from
`@happier-dev/plugin-sdk/contributions`, plus validator-neutral schema
constructors from `@happier-dev/plugin-sdk/protocol`. It needs an explicit
versioned feature contract and maintained target/contributor proof; ordinary
authors consume that feature-owned value rather than creating a parallel
protocol.

The two browser-safe authoring entrypoints keep their owners explicit. The
public-but-not-feature-protocol classifications are:

- `pluginJsonValuesEqual`: `feature-or-host-implementation`; it is the
  canonical structural JSON comparison primitive for implementation code, not
  an ordinary feature-protocol declaration dependency. A public conformance
  fixture exported from `<feature>-protocol/testing/v1` may use it
  only to compare an emitted declaration with its canonical schema; root and
  `/v1` production sources remain denied.
- `ContributionSurfaceNodeInput`: `target-authoring`; it types a target's
  `.node(...)` helper rather than the feature-owned protocol that declares a
  surface role.

Plugin code remains trusted package code under the one whole-package **Install
& Trust** decision. Protocol schemas and role bounds provide deterministic
interoperability and currentness; they are not a sandbox. Read the full
[cross-plugin contribution guide](../../apps/docs/content/docs/plugins/guides/cross-plugin-contributions.mdx)
before defining a feature protocol or binding a contributor.

Bundled and externally installed plugins are eligible for the same Action
capabilities. Public user operations are broadly available through the
invocation-scoped Action service and start Allowed on the **Trusted plugins**
surface; a present user can set an individual Action to **Ask first** or
**Off**. Happier still stamps plugin identity, activation generation, and
`account_automation` authority. Trust does not let a plugin impersonate the
present user, another plugin, or a retired generation, so approval and
security-control operations return `present_user_required` rather than
acquiring a second plugin-only policy path.

## 1. Create and develop a plugin

Use the CLI scaffold rather than copying repository fixtures:

```bash
happier plugins create my-plugin
cd my-plugin
happier plugins dev
```

`plugins dev` prepares declared dependencies automatically. Do not run
`happier plugins dev install .` before this normal create-to-dev loop;
`author install` is reserved for an external-author fixture. When the SDK must
resolve through an approved registry origin, use
`happier plugins dev --sdk-registry <origin>`.

Use `--id com.example.my-plugin` when you need a publisher-owned identifier.
The same beginner command creates an executable UI package when the product
needs one:

```bash
happier plugins create my-native-plugin --ui reactNative
happier plugins create my-hosted-plugin --ui hostedWeb
```

The React Native selection creates one public `@happier-dev/plugin-ui` surface
and one universal CommonJS artifact used on web, iOS, and Android. The hosted
selection creates an isolated static directory and the canonical guest
bootstrap client; its optional TypeScript entry is compiled by the same SDK
esbuild owner. The selection itself does not advertise a packaged runtime
platform; the host may load hosted content only after its platform-specific
frame adapter is present and verified.
The generated package scripts use the managed lower-level author checks. Build,
test, and exercise the same project through source development:

```bash
happier plugins dev build .
happier plugins test .
happier plugins dev
```

Focused typecheck diagnostics remain available through
`happier plugins dev typecheck .`.
`happier plugins doctor .` resolves the exact author entry, evaluates it once,
and reports import failures or observable evaluation slowness. Doctor output is
diagnostic; it does not claim that repeated evaluation proves purity or a
reproducible build.

Installed SDK packages include maintained public patterns under
`node_modules/@happier-dev/plugin-sdk/examples/`. Start from the smallest
matching example and use the generated `API.md` as the import authority.

`plugins dev` is the normal automatic watch-and-replace loop. For a deliberate
watcher-free update, use the same development-source path and reload from the
plugin root:

```bash
happier plugins install . --dev
happier plugins reload
```

When the current directory is ambiguous or you run the command elsewhere, name
the intended development plugin explicitly: `happier plugins reload
com.example.my-plugin`. Both paths use daemon-owned trust, validation,
generation replacement, and cleanup; a rejected change keeps the last accepted
generation serving.

`happier plugins test .` runs the scaffold's focused
`test/index.test.mjs` suite through Happier's managed JavaScript runtime. The
generated `save-note` contract passes from an untouched scaffold and shows the
shape for the first domain contract your plugin must preserve; the adjacent example then loads `dist/index.js`,
passes its exported `manifest` and `activate` through the public testkit, and
invokes the declared `save-note` Action without starting a daemon or mutating
installed plugin state. Use the
managed source-development lifecycle for daemon activation, replacement,
restart, and cleanup QA.

## 2. Author a code-defined plugin

> Source-stage note: the authoring helper, public workspace exports, exact entry
> resolver, evaluator, doctor, static pack paths, and `dev` install-admission
> integration are implemented in the current tree. The package is still private
> and unpublished, so this documents the current source contract rather than an
> approved public release.

A development plugin can be a `.ts`, `.mts`, `.js`, or `.mjs` file. A directory
plugin resolves `src/index.ts` or `index.ts`; having both is an error. If neither
exists, the resolver uses an existing module with one of those extensions from
`package.json`'s `main` field. Daemon entry modules do not use `.tsx`, CommonJS,
or default-export activation.

```ts
import { definePlugin } from '@happier-dev/plugin-sdk';
import {
  defineProtocolObject,
  defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';

export const { manifest, activate } = definePlugin({
  id: 'com.example.echo',
  version: '0.1.0',
  entrypoints: { daemon: './dist/index.js', development: './src/index.ts' },
  actions: {
    echo: {
      title: 'Echo',
      execution: { target: 'daemon' },
      inputSchema: defineProtocolObject({
        text: defineProtocolString({ minLength: 1 }),
      }, { policy: 'closed' }),
      async run(input) {
        return input;
      },
    },
  },
});
```

`definePlugin` returns the ordinary named `manifest` and `activate` ABI. It is
authoring sugar, not a second runtime. Generated registrations run before the
optional `setup(api)` callback, and `setup` may return the module's one cleanup
function.

Authors omit `runtime.apiVersion`; the current host ABI is supplied by default.
`engines.happier` is optional: set a compatible host range only when your plugin
requires one. For hooks, declare `on` and any `filters`, `priority`, or
`hostAccess` options alongside the handler. The canonical host hook catalog
supplies category, scope, and execution kind; no hook API version is authored.

`defineProtocolString` and `defineProtocolUtf8String` are non-normalizing: an
accepted string is returned byte-for-byte as authored. Patterns are ordinary
ECMAScript regex sources and never acquire private semantics during cold schema
rehydration. When canonical spelling matters, express it as an ordinary string
constraint such as a pattern rather than a transform. The only Happier JSON
Schema extensions are the UTF-8 byte and serialized UTF-8 byte ceilings.

For retained schema-shaped JSON in the 0.3 development source contract, use
`createProtocolStoredReadSchema(schema)` from `/protocol`. Its persistence-only
reader projects declared fields recursively and validates known values; opaque
JSON values remain opaque. Unknown fields do not grant identity or authority.
Keep the original schema for fresh inputs and canonical writes: the stored
reader is not an Action input schema. See the
[stored-reader policy](../../docs/compatibility.md#tolerant-stored-data-readers).

Activation runs in the shared daemon process. Register promptly and defer
business work until invocation; synchronous CPU or blocking work can stall
other plugins and sessions.

Development evaluates the selected module only after source-root trust. Pack
evaluates the same resolved author module once and serializes its canonical
projection to `.happier-plugin/plugin.json`. Installed and marketplace
discovery read that generated JSON and never execute plugin code.

### Capture sources and media viewing

The 0.3 media interface is under development; use it only when the installed
API inventory and capability matrix include the capture/media exports.
`definePlugin` accepts manifest-backed producers under `captureSources`:

```ts
captureSources: {
  preview: {
    declaration: {
      displayName: 'Preview',
      streamFamily: 'acme.preview',
      supportedCodecs: ['image.mjpeg'],
    },
    runtime: previewCapture,
  },
}
```

`previewCapture` implements `PluginCaptureSourceRuntime`: `start` receives an
assigned stream id, cancellation signal, frame offer and receipt callbacks,
then returns a `stop` operation. The host owns viewer routing and transport;
the producer does not register a second viewer or input controller.
An admitted surface renders its own source with `HappierLiveStream` from
Plugin UI. A host-source reference instead requires a `capture.view` Action
approval for each viewing, unless the user waived approval for this plugin in
Action settings. Replacement retires the exact old viewing.

`StoredImageRefV1` carries the complete file-backed native Session-image reference,
including dimensions, byte size, Session storage path and digest. References can
be reused after remounting or handed to another plugin; the bound `readStoredImage` operation
requires the plugin's declared/selected Sessions READ scope and matching Account
encryption mode. The daemon verifies the exact file and digest before disclosure;
reference possession or a successful Action is not read permission. See the
[Plugin UI media interface](../plugin-ui/README.md#capture-previews-and-session-images)
for rendering and unavailable-host behavior.

## 3. Test, pack, and exercise the real host boundary

```ts
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as module from '../src/index.js';

const plugin = await createPluginTestkit({ manifest: module.manifest, module });
await plugin.invokeAction('echo', { text: 'hello' });
await plugin.dispose();
```

The testkit validates projection, activation, registrations, actions, and
cleanup without mutating installed state. Run the source suite, then exercise
the managed source-development daemon boundary for claims about activation,
replacement, restart, and cleanup:

```bash
happier plugins test .
happier plugins dev
```

## Invocation context and interactions

The named `manifest` plus `activate(api)` module shape is the host's internal
compiled ABI that `definePlugin(...)` compiles to; authors do not hand-maintain
that spelling. The maintained `examples/public-authoring/` package is the
broad code-defined conformance reference.

Handlers receive `PluginInvocationContext`, including plugin and contribution
identity, cancellation, bounded services, and optional presentation-only
`context.ui`. Fully qualified contribution ids use `pluginId/family/localId`
slash form; for the `echo` action declared above,
`com.example.echo/actions/echo`.

`context.services.interactions` owns present-user requests and the canonical
approval queue. Each author request has an explicit `kind`; host-generated
results carry `requestId` and the matching `kind`:

- `requestApproval({ kind: 'approval', title, description?, subject,
  allowSessionPersistence? })` returns `approved`, `declined`, or a terminal
  status. An approval can carry `persistence: 'once' | 'session'`, but `session`
  is possible only when the author allowed it;
- `askQuestions({ kind: 'questions', title?, questions })` returns `answered`
  with typed answers, or a terminal status;
- `confirm({ kind: 'confirmation', title?, message })` returns `approved`,
  `declined`, or a terminal status—it is not a boolean;
- `approvals.request/get/list/watch` accesses the host-stamped canonical
  approval queue.

For native Agent Sessions in the development SDK, interaction options default
to `lifetime: 'turn'`. Native asynchronous questions may explicitly use
`{ lifetime: 'occurrence' }`
to remain answerable after the turn ends, until their runtime occurrence retires.
This changes cleanup lifetime, not the request's host-stamped causal turn or
permission authority. An explicit abort signal still ends the request.

The exact terminal statuses are `userCancelled`, `requesterAborted`, `timedOut`,
`sessionEnded`, `generationRetired`, `hostRestarted`, and `unavailable`. They are
returned in the kind-specific result unions, rather than being remapped into
legacy interaction `PluginError` codes.

The host owns whether a request has a deadline at all. An interactive prompt in
the exact current Session has none: it waits for the person and can only end in
an answer/decision, `userCancelled`, `requesterAborted`, `generationRetired`,
`sessionEnded`, or `unavailable`. `timedOut` is reachable only where the host
binds a deadline, such as a present-user application invocation that carries its
own invocation budget.

`context.services.sessions.current.setDisplayTitle(title)` is the bounded,
current-session capability for durable Session titles. Handles from
`sessions.get(id)` intentionally do not expose it.

When present, `context.ui` owns only invocation-local presentation:

- `notify(message, { severity? })` reports an invocation-local message;
- `status.set`, `widget.set`, and `composer.replace` update host-owned
  presentation state.

The host owns request identity, correlation, cancellation, currentness,
reconnect state, and present-user custody. Authors supply typed intent, not
transport, provider-specific interaction metadata, host request stamps, or
broader workspace/account persistence.

## Connected Accounts

`context.services.connectedAccounts` gives an authorized contribution access
to one host/user-selected account or account group for each declared purpose.
The stable consumer methods are:

- `getBinding(purpose)` for a redacted binding summary or `null`;
- `requestSelection({ purpose, reason })` for host-owned selection;
- `materialize(purpose, request)` for a point-in-time header, environment, or
  file credential snapshot;
- `listAccounts({ purpose, limit? })` for bounded non-secret metadata from the
  exact bound account or the bound group's current enabled members;
- `materializeListedAccount({ purpose, account, materialization })` for a
  revalidated snapshot of one account from that same bound target;
- `watch(purpose, listener)` for generation-local opaque `{ kind: 'resync' }`
  invalidation.

Only `requestSelection()` requires an available current-session interaction
owner. It fails typed with `plugin_interaction_cancelled` or `plugin_interaction_unavailable`
when the host cannot complete that user decision. An already-bound,
currently authorized purpose can still use `getBinding()`, `materialize()`,
`listAccounts()`, `materializeListedAccount()`, and `watch()` outside a session;
these methods expose only the exact purpose-bound target, never the host-private
account inventory.

Actions and hooks use the ID of their existing `connectedAccounts` HostAccess
request as the purpose. `select` authorizes selection; `use` authorizes binding
inspection, listing, materialization, and watch. Agent contributions declare
their long-lived purposes in `connectedAccounts[]`; a declaration may include a
localized title for host presentation, but its raw purpose ID remains
machine-only. A plugin cannot enumerate unrelated accounts, choose a group
member, refresh credentials, report account failures, or observe Connected
Services generations/revisions through this API.

Materialized credentials must not be persisted or emitted. On a resync,
discard reliance on the previous snapshot and materialize again. See the
canonical Connected Accounts service guide under
`apps/docs/content/docs/plugins/services/auth-connected-services.mdx`.

Plugins that produce Connected Accounts declare one service with one or more
named authentication modes, then register one matching runtime:

```ts
api.connectedAccounts.register('forge', {
  authentication: {
    modes: {
      manual: {
        kind: 'manual',
        async complete(input, context) {
          // Validate input and stage credentials. Return accountId only when
          // the provider supplies a truthful immutable service-local ID;
          // otherwise omit it so the host mints an opaque canonical ID.
        },
      },
    },
  },
  // refresh, revoke, status, quota?, and materialize
});
```

The host requires exact equality between descriptor and runtime mode IDs and
kinds. A descriptor's `outcomeReconciliation: 'providerCheck'` requires its
runtime mode to expose `reconcile`; `lateEvidence` and `none` forbid it.
Possible remote effects return `outcomeUnknown` and are never blindly replayed.
Connect and reconnect contexts are discriminated, and reconnect always names
the exact qualified account rather than relying on current selection.

Each invocation receives a daemon-normalized configuration snapshot for its
exact service/account and mode. A first connect that collects account-scoped
configuration before a canonical account ID exists uses only an operation-local
`attempt` target; it never invents a provisional account ID. Successful
connection promotes that staged configuration to the returned exact account.
Non-secret values are in `values`; secrets are available only through bounded
`getSecret()`. Descriptor configuration fields declare `service` or `account`
scope and `refresh` or `reconnect` change behavior. They cannot use Plugin
Settings `presentation.binding`, and neither descriptors nor UI projections
contain secret values.

Any authentication mode may mark required, non-secret string configuration
fields with `semantic: 'connectedAccountOrigin'`. Each marker selects that
field's current persisted value for HostAccess resolution; it contains no
origin or grant itself. Such fields cannot declare a default, enum, const, or
composed schema. Network authority still comes only from a same-plugin manifest
`network` request targeting the exact Connected Account service.

A successful authentication result's optional top-level `accountId` proposes
an immutable qualified-service-local canonical ID only when the plugin has a
truthful stable value. When a first connect has no such value, omit
`accountId`; the host mints an opaque ID independently of the operation's
`attemptId` and reuses that prepared ID for any ambiguous settlement reread.
Reconnect remains bound to the admitted exact account ID. Provider account
ID/email, display name, and scopes are mutable metadata; put provider ID/email
under `providerIdentity`. Public descriptors do not expose host adapters,
origins, or permissions. Producer network authority comes only from the
existing manifest `network` HostAccess request for the exact
`connectedAccountOrigin`.

`askQuestions` uses the exact `InteractionTransientQuestionsAuthorRequestV1`
shape: a non-empty `questions` array under `kind: 'questions'`. The question
types are `text`, `singleChoice`, and `multipleChoice`; author `required`,
`allowCustom`, and choice labels are optional.

```ts
const result = await context.services.interactions.askQuestions({
  kind: 'questions',
  title: 'Choose a destination',
  questions: [{
    id: 'destination',
    prompt: 'Where should this publish?',
    type: 'singleChoice',
    required: true,
    choices: [
      { id: 'staging', label: 'Staging' },
      { id: 'production', label: 'Production' },
    ],
  }],
}, { signal: context.signal });

if (result.status === 'answered') {
  const answer = result.answers.destination;
  if (answer?.kind === 'singleChoice' && answer.answer.kind === 'choice') {
    await publishTo(answer.answer.choiceId);
  }
}
```

Text answers are `{ kind: 'text', value }`; single-choice and multiple-choice
answers use `kind: 'singleChoice'` and `kind: 'multipleChoice'`. A choice
selection is `{ kind: 'choice', choiceId }` or `{ kind: 'custom', value }`.
Custom values are the provider-neutral “Other” answer; provider-native adapters
preserve their own answer semantics behind this boundary.

## Agent runtimes

Register native `AgentRuntime` implementations from
`@happier-dev/plugin-sdk/agents/runtime`. A runtime registers exactly one
factory: a `sessions` factory **or** an `executionRuns` factory — the public
type is an exclusive union, so a runtime can never supply both. Happier owns
shared session and turn lifecycle, input custody, transcript persistence,
activity, and process-terminal state; the plugin supplies Agent-native commands,
codecs, correlation, and authoritative evidence.

Choose the task before writing a factory:

- declarative ACP uses `runtime.kind: 'acp'` and cold transport data only—no
  factory, registration, or locator;
- custom persistent Session Agents register a `sessions` factory and require a
  distinct named `sessionRunnerFactory` leaf that exports that same factory;
  for Session-capable Agents the host derives the finite Execution Run
  projection from the registered Session factory, and the plugin never
  registers or owns a second Run lifecycle; and
- custom execution-run-only Agents register an `executionRuns` factory and have
  no Session runner locator. The public finite-run seam exists only for
  genuinely execution-only Agents.

The daemon activation entry calls `activate`; the Session runner imports only
the named leaf. They can run in different realms, so neither relies on a
process-global singleton. Start a custom persistent Session Agent from the
minimal executable `examples/session-agent/` reference. It demonstrates one
public `definePlugin(...)` registration, a distinct runner leaf, strict runtime
events, a host interaction, and cancellation without a Provider or private host
import. Use `examples/advanced-package-root/` only when that same package also
needs an External Sessions companion, Connected Account purpose, managed
Provider, Resource, or background runner.

After its source checks pass, keep the Session-Agent lifecycle canary explicit:

```bash
happier plugins pack . --out ../session-agent.tgz
happier plugins install ../session-agent.tgz --kind archive
```

Archive installation requires present-user trust approval. The public Agent
authoring route remains the one `definePlugin(...)` entry; its current focused
fields include:

- `providerCliAttach` for target resolution, CLI arguments, and a health URL
  while the host retains process and connection custody;
- `cliSessionCommand` for static Agent-native CLI forwarding and an optional
  bounded Session-options builder whose input includes parsed arguments,
  host-resolved settings and environment, and `startOrigin`;
- `preflightSessionControls` for bounded Agent-native control discovery while
  the host owns tool/process/JSON-RPC execution and caching;
- `terminalPromptSubmitVerification` for Agent-native recognition around the
  host's existing terminal submit verification; and
- `sessionStartup` and `vendorResumeSupport` for narrow eligibility decisions
  inside host-owned deferred startup and experimental vendor-resume gates.

Static prompt blocks and login-status resume-checklist inclusion belong in the
Agent declaration's strict `catalog.codingPromptBehavior` and
`catalog.resumeChecklist` fields. For a declarative ACP Agent, the optional
strict `runtime.definition` carries `modelConfigOptionId`, bounded
`stderrRules`, the permission-mode mapping, the MCP input policy, and two
further data-only declarations the host executes on the Agent's behalf: Kiro is
the current positive consumer of the base fields, and Devin of both additions.
`mcp.nativeSessionConfig` declares that this Agent reads MCP servers from its
own config file, so the host writes the merged server map into a
session-private config root that links the user's real provider state and
points the declared config-root variable at it for one launch; the input policy
stays `drop` because those servers are already delivered. `models.suffixOption`
declares that the Agent advertises one model per option value in the model id,
so the host presents one model plus that canonical option and expands the
selection back to the advertised id. Both stay data because the out-of-process
Session runner rebuilds a declarative runtime from the attested manifest alone
and never loads plugin code.
Custom ACP composition in 0.3 development also accepts the optional
`definition.sessionUpdates.project(update)` metadata codec. Return
`{ toolMetadata: { mcp: { server, tool }, internal } }` for native tool
provenance, `{ diagnostic: { code, severity, message, details } }` for a status
observation, or `null` for an unrelated update. The host retains its single tool
accumulator, transcript publisher and turn lifecycle; a recovery diagnostic
never becomes permission to retry or a claim that the turn completed. Standard
tool names and session titles need no Agent-specific codec. See the
[ACP author example](../../apps/docs/content/docs/plugins/agent-runtimes/acp.mdx#native-update-metadata).
This executable hook requires matching development host and plugin source; it
is not part of a data-only declarative ACP manifest. Its optional
`projectStopReason(raw)` translates only semantically equivalent native reasons
to ACP v1 reasons; return `null` to retain an unknown outcome. The generic host
keeps that raw value for diagnostics without claiming success or failure.

The host owns authentication classification across ACP Agents;
`stderrRules.authenticationErrorDetail` only customizes the resulting status
message, while `suppress` and `statusErrors` cover other bounded stderr cases.
For Session-capable Agents the host derives finite Runs from the registered
Session factory. Plugin authors do not register or own a second Run lifecycle.

In the development SDK, the optional Session terminal service operation
`adoptExistingHost()` admits an exact surviving owned host without spawning.
Call it only from an admitted Session recovery path: `null` means no owned
candidate, while unreadable, replaced or unproven host evidence rejects. The
host retains lock, attachment and lifecycle authority; the Agent still establishes
its native session identity from authenticated native evidence. An inherited
foreground shell remains borrowed. Hosts without this optional operation cannot
perform that adoption; see [protocol evolution](../../docs/compatibility.md#sdk-protocol-evolution).

## Task guides

In the current development SDK, a custom Session can bind live mode facts with
`context.session.services.modes.bind(source)`, alongside the existing `models`
service. The source exposes `read()` and `subscribe()`; the returned binding
retires with the Session. Publish native accepted current facts, not desired
configuration intent. `modes: null` means unknown or unbound; `modes: []` means
an observed withdrawal. The host owns the active Session's UI metadata projection.
Known modes remain selectable when `currentModeId` is unknown. The canonical
projection is `sessionModesV2`; strict V1 compatibility is emitted only for a
known accepted current mode.

The ordinary author journey continues in the task-first guides under
`apps/docs/content/docs/plugins/guides/`:

- `providers.mdx` distinguishes descriptor-only Providers from managed local
  Provider lifecycle/adoption.
- `scm.mdx` distinguishes forge hosting Providers from repository backends.
- `voice.mdx` distinguishes conversation, STT, and TTS.
- `background-services.mdx` covers daemon-generation background work.
- `invocation-services.mdx` maps actions, events, HTTP, interactions,
  Providers, resources, and MCP to their one context service owner.

## Voice author paths

Voice has three realm-correct public paths:

```text
@happier-dev/plugin-sdk/voice
@happier-dev/plugin-sdk/voice/client
@happier-dev/plugin-sdk/voice/speech
```

`/voice` owns realm-neutral declarations, credentials, and the discriminated
runtime registration contract. Conversation leaves import browser/mobile
runtime types from `/voice/client`; daemon STT/TTS leaves import speech runtime
types from `/voice/speech`. Each binds through
`api.voiceProviders.register(localId, runtime)`. Give independently selectable
STT and TTS implementations separate contribution ids. The similarly named UI
client path is only the hosted-web bootstrap and is not a Voice runtime API.

A realtime disconnect with a pending tool result settles as
`voice_tool_result_delivery_unrecoverable`. The visible Retry starts a new
conversation; the host does not replay tool results into a replacement carrier.
Effect deduplication under an actual provider tool-call id remains separate.
Saved provider conversations and Forget are supported when the runtime registers
`forgetProviderConversation`; they do not imply tool-result replay.

## Plugin UI

- Declarative surfaces are validated and rendered by the host.
- Hosted web surfaces are isolated UI and use the public bridge.
- React Native surfaces are trusted client code and are the default
  native-feeling executable UI model.

Hosted web isolation does not sandbox daemon code. Installation is a
whole-package **Install & Trust** decision.

Hosted web code receives its whole render context from the injected bootstrap
at the exact public path:

```ts
import { createPluginUiRenderContext } from '@happier-dev/plugin-sdk/ui/client';

const context = await createPluginUiRenderContext();
const host = context.hostApi;
```

The context is host-issued and is cancelled when its surface retires. Do not
parse launch input or subpaths from a frame URL. React Native code instead
exports a surface through the public semantic package:

```tsx
import { defineUiSurface } from '@happier-dev/plugin-ui';

export const renderSurface = defineUiSurface(function PluginSurface() {
  return null;
});
```

`defineUiSurface` installs the one provider around the host's
`RenderContext`; React Native renderers do not use the hosted-web bootstrap
client or construct another provider.

In 0.3 development, `RenderContext.launch` is `{ kind: 'explicit', input? }` for one staged explicit open per mount instance; it is absent on layout restore or reload, even when the route identifies an item.

Build UI with public helpers from `@happier-dev/plugin-sdk/ui/build`; the host
verifies the emitted artifact manifest and content before use.

## Checkpointed Event observers (0.3 development)

Declare the strict Event and source setup Action through the existing Event
authoring contract. Run its finite provider adapter from the daemon-only
`background-services` entrypoint:

```ts
import { definePlugin } from '@happier-dev/plugin-sdk';
import { runCheckpointedPluginEventObserverV1 } from
  '@happier-dev/plugin-sdk/background-services';
import { issueSource } from './issueSource.js';

export const { manifest, activate } = definePlugin({
  id: 'com.example.issues',
  version: '0.1.0',
  entrypoints: { daemon: './dist/index.js' },
  backgroundServices: [{
    declaration: { id: 'observe-issues', title: 'Observe issues' },
    runner: context => runCheckpointedPluginEventObserverV1({
      context,
      source: issueSource,
    }),
  }],
  // Keep the plugin's Event and setup Action declarations here.
});
```

`issueSource` implements `PluginCheckpointedEventSourceAdapterV1<Source,
Checkpoint>` from that same daemon entrypoint. Its `decode` selects a current
definition; `observe` uses the plugin's finite client, pagination and cursor
reader to return `observations`, an optional opaque `checkpoint`, `complete`
and `nextEligibleAt`. `save` preserves its existing cursor codec and CAS store.
`retryAt` derives eligibility from provider retry instructions or the configured
source period. A finite provider failure can also return the existing typed
source `status` (`state` and `code`). Adapters own no observation loop or timer.

Continuous observers retain one original candidate while its admission awaits
approval. By default, that source waits for settlement before observing again.
An adapter whose `observe` preserves the retained candidate until `save` can set
`observeWhileAdmissionPending: true` to continue its advancing provider deadlines,
as the health adapter does for current health publication. The runner still
admits once and serializes the original checkpoint save before the next
observation. A non-advancing buffered drain waits for settlement or an
authenticated wake. Finite `once` mode awaits admission and save.

The runner compares the assignment with **its own host-stamped
`context.materialization`** before provider or checkpoint work. Missing or
mismatched materialization refuses observation; `context.caller` is not a
substitute. It shares one cycle across a native source's Event declarations and
subscribers, admits occurrences through the existing Automation owner and saves
only a complete, entirely checkpoint-safe candidate that is still current.
Cancellation and source invalidation withdraw in-flight publication authority.
A healthy empty catalog waits for invalidation without a timer or provider call.

Checkpoint safety does not prove an Event admitted execution: filtered or stale
observations can be safely skipped. The existing `save` input carries the final
`disposition`; its optional `admissions` retains each observation identity,
definition selector, transport scope and exact server result. An admitted-only
effect must match its own observation and current definition and require an
`admitted` or `rejoined` result. All skipped, missing metadata or an unsettled
attempt never authorizes that effect. Safe skips may still save cursor or notice
facts. The finite processor passes this same disposition to its commit callback.

An adapter's multi-step save must keep honoring `context.signal` and recheck
`isCurrent()` before each outward effect or CAS write. When an existing
Account-bound target Action must retain credential, notice and checkpoint
custody, call `processCheckpointedPluginEventAttemptV1` inside that finite Action
with its current definitions, observations and commit closure. This is the same
safety processor the runner uses. Finite reset Actions can reuse
`readCheckpointedPluginEventSourcesV1` for the same strict catalog pager.
These APIs describe unreleased development source, not a released host promise.

## Testkit reference

```ts
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as module from '../src/index';

const plugin = await createPluginTestkit({ manifest: module.manifest, module });
await plugin.invokeAction('echo', { text: 'hello' });
await plugin.dispose();
```

The testkit validates the manifest, activates the module, enforces declared
registration ids, invokes actions, and runs cleanup. It is not a substitute for
packing and exercising install, trust, development, update, UI, and uninstall
flows in a real host.

In 0.3 development source, use `createPluginClientTestkit({ manifest, target,
activate })` from `/testing` for a client artifact. The target is its exact
`{ artifactId, exportName, platform }`; the existing contribution catalog owns
the rights. Retrieve typed runtimes with `registration(family, id)`, inspect
`registrations()`, and always `dispose()` the fixture. A handler receives the
client invocation context supplied by your test, not a daemon service context.
The public-authoring example includes this client activation pattern.

The ordinary testkit's `observeAction` exercises a declared read observer without
running its handler; supply an invalidation function with `retire()` and dispose
the returned subscription. At a mocked host Action transport,
`createPluginActionHandlerUnavailableFixture()` models a refusal before the
handler starts, using the canonical missing-handler error and advisory.

Canonical author docs live in `apps/docs/content/docs/plugins/`. Source examples
under this package are compile fixtures; the CLI scaffold's code-defined module
is the external development authoring source of truth, and managed source
development consumes its generated cold manifest.

## Repository validation

From the Happier repository root:

```bash
pnpm --filter @happier-dev/plugin-sdk run test
pnpm --filter @happier-dev/plugin-sdk run typecheck
pnpm --filter @happier-dev/plugin-sdk run build
```

Feature QA validates the current source and loaded development stack. Release
automation owns publication output and its release-only verification.
