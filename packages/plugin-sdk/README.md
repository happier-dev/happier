# `@happier-dev/plugin-sdk`

The public authoring contract for Happier plugins. It covers cold manifests,
daemon activation, invocation services, native Agent runtimes, Plugin UI, UI
builds, and the plugin testkit.

## Public SDK release posture

The SDK has one package-level **Developer Preview** source contract. The
workspace package remains `private: true` at `0.0.0` and is unpublished while
the publication gates are open. No public version or released-semver policy is
established by the current source tree, and a workspace build must not be
presented as a published SDK.

Developer Preview is not a per-symbol stability tier. The publisher-generated
API inventory is the public census and retains publication-derived `@since`
metadata; structured deprecation remains separate. The generated
`capability-matrix.json` is the availability authority. Source exports,
examples, host wiring, source tests, and loaded development-stack lifecycle QA
establish feature readiness.

Tool and Command declarations are currently deferred for external authors.
Both require their canonical host-catalog and loaded development-stack proof,
including replacement, disable, and uninstall currentness, before their
generated availability metadata or public docs can advertise them as usable.
Preview status does not waive correctness, installability, lifecycle cleanup,
security disclosure, examples, or documentation.

## Cross-plugin protocol authoring

Use the [SDK protocol-evolution doctrine](../../docs/compatibility.md#sdk-protocol-evolution)
whenever an SDK author surface, Host Event, or cross-plugin business protocol
changes. A wire epoch is semantic and independent from an npm package version;
an optional input is safe only if an older implementation can ignore it without
claiming false success. New union members are safe only for explicitly skippable
bounded presentation lists—not identity, authority, presence, permission,
pagination, retry, or mutation-outcome unions.

Independently published business protocols use
`@happier-dev/<feature>-protocol` with explicit `/v1` and `/testing/v1` exports.
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
  an ordinary feature-protocol declaration dependency. A public
  `@happier-dev/<feature>-protocol/testing/v1` conformance fixture may use it
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
and its declared web, iOS, and Android artifacts. The hosted selection creates
an isolated Vite artifact and the canonical guest bootstrap client. The
selection itself does not advertise a packaged runtime platform; the host may
load that artifact only after its platform-specific frame adapter is present
and verified.
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

A simple development plugin is one `.ts` or `.mts` file. A directory plugin
uses exactly `src/index.ts` or `index.ts`; having both is an error. Daemon entry
modules do not use `.tsx`, CommonJS, or default-export activation.

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

Daemon activation has an internal 30-second deadline for asynchronous
`activate(api)` settlement. This deadline is host policy, not plugin
configuration. It cannot preempt synchronous CPU or blocking work in the shared
daemon process, so activation code should register promptly and defer business
work until invocation.

Development evaluates the selected module only after source-root trust. Pack
evaluates the same resolved author module once and serializes its canonical
projection to `.happier-plugin/plugin.json`. Installed and marketplace
discovery read that generated JSON and never execute plugin code.

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

## Manual ABI (advanced conformance)

The manual ABI remains supported for broad/conformance examples: export a
canonical named `manifest` plus a named `activate(api)` function. It is not the
ordinary scaffold path. Registration is static and returns `void`; successful
activation may return one cleanup function. The maintained
`examples/public-authoring/` package is the broad code-defined conformance
reference. Prefer `definePlugin(...)` for a normal author package.

```ts
import type { PluginApi } from '@happier-dev/plugin-sdk';

export function activate(api: PluginApi) {
  api.actions.register('echo', async (input, context) => {
    const confirmation = await context.services.interactions.confirm({
      kind: 'confirmation',
      message: 'Echo this input?',
    }, { signal: context.signal });
    if (confirmation.status !== 'approved') return;
    await context.ui?.notify('Echoed', { severity: 'info', signal: context.signal });
    return input;
  });

  return async () => {
    // Dispose plugin-owned resources.
  };
}
```

Handlers receive `PluginInvocationContext`, including plugin and contribution
identity, cancellation, bounded services, and optional presentation-only
`context.ui`. Fully qualified contribution ids use `pluginId/family/localId`
slash form; for this action,
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
`@happier-dev/plugin-sdk/agents/runtime`. A runtime supplies a `sessions` factory,
an `executionRuns` factory, or both. Happier owns shared session and turn
lifecycle, input custody, transcript persistence, activity, and process-terminal
state; the plugin supplies Agent-native commands, codecs, correlation, and
authoritative evidence.

Choose the task before writing a factory:

- declarative ACP uses `runtime.kind: 'acp'` and cold transport data only—no
  factory, registration, or locator;
- custom execution-run-only Agents register an `executionRuns` factory and have
  no Session runner locator;
- custom persistent Session Agents register a factory and require a distinct
  named `sessionRunnerFactory` leaf that exports that same factory; and
- composite Agents expose both facets, but still use the Session runner leaf.

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
strict `runtime.definition` carries only `modelConfigOptionId`, bounded
`stderrRules`, and the MCP input policy; Kiro is the current positive consumer.
When finite Runs reuse the Session adapter, call
`createExecutionRunHostBackendFromSessionRuntime` instead of owning a second
Run lifecycle.

## Task guides

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

When a realtime `prepare` result can reconnect to the same provider response,
it may set `session.toolResultReplay: 'stable_ids'`. Set it only for the exact
prepared carrier that can accept already-settled tool results under the
original response and call ids; omit it (or set `'none'`) for a fresh carrier.
The host treats omission as fail-closed and never reruns a settled effect to
make a fresh provider session accept it.

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

Build UI with public helpers from `@happier-dev/plugin-sdk/ui/build`; the host
verifies the emitted artifact manifest and content before use.

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

Canonical author docs live in `apps/docs/content/docs/plugins/`. Source examples
under this package are compile fixtures; the CLI scaffold's code-defined module
is the external development authoring source of truth, and managed source
development consumes its generated cold manifest.

## Repository validation

From the Happier repository root:

```bash
yarn workspace @happier-dev/plugin-sdk test
yarn workspace @happier-dev/plugin-sdk typecheck
yarn workspace @happier-dev/plugin-sdk build
```

Feature QA validates the current source and loaded development stack. Release
automation owns publication output and its release-only verification.
