# `@happier-dev/plugin-sdk`

The public authoring contract for Happier plugins. It covers cold manifests,
daemon activation, invocation services, native Agent runtimes, Plugin UI, UI
builds, and the plugin testkit.

## Public SDK release posture

The approved first public version is `0.1.0`. Every public path is
**Developer Preview** until 1.0:

- patch releases should not intentionally break documented contracts;
- a documented 0.x minor may include breaking changes with migration notes;
- preview status does not waive correctness, installability, lifecycle cleanup,
  security disclosure, examples, or documentation.

The workspace package remains `private: true` and version `0.0.0` while the
publication gates are open. Do not present a workspace build as a published SDK.

## Candidate public paths

The current G5 candidate has eight normal public paths:

```text
@happier-dev/plugin-sdk
@happier-dev/plugin-sdk/manifest
@happier-dev/plugin-sdk/runtime
@happier-dev/plugin-sdk/agent-runtime
@happier-dev/plugin-sdk/ui
@happier-dev/plugin-sdk/ui/client
@happier-dev/plugin-sdk/ui/build
@happier-dev/plugin-sdk/testing
```

Other author-facing exported paths are explicitly under `experimental/*` and
are not normal authoring promises. This surface remains on prepublication hold until the
consolidated API receives explicit approval. The candidate root convenience
surface is limited to
`JsonValue`, `Disposable`, `PluginApi`, `PluginInvocationContext`,
`PluginDiagnosticData`, `PluginErrorData`, and `PluginError`.

## Create a plugin

Use the CLI scaffold rather than copying repository fixtures:

```bash
happier plugins create my-plugin
cd my-plugin
happier plugins dev
```

Use `--id com.example.my-plugin` when you need a publisher-owned identifier.
The generated package scripts use the managed lower-level author checks. After
developing, build, test, and pack the same project:

```bash
happier plugins author build .
happier plugins test .
happier plugins pack .
```

Focused typecheck diagnostics remain available through
`happier plugins author typecheck .`.

Install the emitted npm-compatible tarball with:

```bash
happier plugins install <archive-path> --kind archive
```

Use the archive path emitted by `pack`; its exact filename can vary with package
metadata and `--out`. In an interactive terminal the daemon presents the exact
package facts before the single **Install and trust** decision.

`happier plugins test .` runs the scaffold's focused
`test/index.test.mjs` suite through Happier's managed JavaScript runtime. The
generated test activates `dist/index.js` with the public testkit and invokes
the declared `save-note` action without starting a daemon or mutating installed
plugin state.
`happier plugins test . --packed` packs the project, installs and trusts it in
an isolated disposable daemon home, activates it, invokes a safe empty-input
CLI action when available, restarts the daemon, and invokes it again. It never
uses or mutates the user's installed plugin state.

## Cold manifest

The external source of truth is `.happier-plugin/plugin.json`. It is JSON, is
validated before executable code loads, and declares identity, entrypoints,
host access, and contributions. Do not import plugin code to construct it.

```json
{
  "schemaVersion": 2,
  "id": "com.example.echo",
  "version": "0.1.0",
  "displayName": "Echo",
  "engines": { "happier": "^0.2.0" },
  "runtime": { "apiVersion": 1 },
  "entrypoints": {
    "daemon": "./dist/index.js",
    "development": "./src/index.ts"
  },
  "contributes": {
    "actions": [{
      "id": "echo",
      "title": "Echo",
      "scopes": ["global"],
      "surfaces": ["agent", "cli", "mcp"],
      "placement": "commandPalette",
      "dangerLevel": "safe",
      "inputSchema": { "type": "object" },
      "resultSchema": { "type": "object" }
    }]
  }
}
```

## Activation and invocation

The daemon entrypoint exports a named `activate(api)` function. Registration is
static and returns `void`. Successful activation may return one cleanup
function.

```ts
import type { PluginApi } from '@happier-dev/plugin-sdk';

export function activate(api: PluginApi) {
  api.actions.register('echo', async (input, context) => {
    await context.ui.notify('Echoed', { severity: 'info' });
    return input;
  });

  return async () => {
    // Dispose plugin-owned resources.
  };
}
```

Handlers receive `PluginInvocationContext`, including plugin and contribution
identity, cancellation, bounded services, and `context.ui`. Fully qualified
contribution ids use `pluginId/family/localId` slash form; for this action,
`com.example.echo/actions/echo`.

`context.ui` is the simple author-facing intent facade:

- `requestApproval({ title, description?, subject: { kind: 'tool', name, input },
  allowSessionPersistence? })` returns `approved`, `denied`, `cancelled`, or
  `unavailable`; `approved` reports `once` or, only when the request allowed it,
  `session` persistence;
- `askQuestions(questions, { title? })` returns `answered`, `cancelled`, or
  `unavailable`;
- `confirm(message, { title? })` resolves to a boolean after a host decision,
  or rejects with `PluginError` code `plugin_ui_cancelled` or
  `plugin_ui_unavailable` when no decision is available;
- `notify(message, { severity? })` reports an invocation-local message;
- `status.set`, `widget.set`, `title.set`, and `composer.replace` update
  host-owned presentation state.

The host owns request identity, correlation, cancellation, currentness,
reconnect state, and present-user custody. Authors supply UI intent and typed
answers, not transport, provider-specific interaction metadata, or broader
workspace/account persistence.

## Connected Accounts

`context.services.connectedAccounts` gives an authorized contribution access
to one host/user-selected account or account group for each declared purpose.
The stable consumer methods are:

- `getBinding(purpose)` for a redacted binding summary or `null`;
- `requestSelection({ purpose, reason })` for host-owned selection;
- `materialize(purpose, request)` for a point-in-time header, environment, or
  file credential snapshot;
- `watch(purpose, listener)` for generation-local opaque `{ kind: 'resync' }`
  invalidation.

Only `requestSelection()` requires an available current-session interaction
owner. It fails typed with `plugin_ui_cancelled` or `plugin_ui_unavailable`
when the host cannot complete that user decision. An already-bound,
currently authorized purpose can still use `getBinding()`, `materialize()`,
and `watch()` outside a session; none of these methods exposes the
host-private account inventory.

Actions and hooks use the ID of their existing `connectedAccounts` HostAccess
request as the purpose. `select` authorizes selection; `use` authorizes binding
inspection, materialization, and watch. Agent contributions declare their
long-lived purposes in `connectedAccounts[]`. A plugin cannot enumerate
accounts, choose a group member, refresh credentials, report account failures,
or observe Connected Services generations/revisions through this API.

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

`askQuestions` accepts a non-empty question tuple. These are the exact
supported-preview question and answer shapes:

```ts
type Question =
  | Readonly<{
      id: string;
      prompt: string;
      type: 'text';
      required?: boolean;
    }>
  | Readonly<{
      id: string;
      prompt: string;
      type: 'single' | 'multiple';
      required?: boolean;
      choices: readonly [
        Readonly<{ id: string; label?: string; description?: string }>,
        ...Readonly<{ id: string; label?: string; description?: string }>[],
      ];
      allowCustom?: boolean;
    }>;

type Questions = readonly [Question, ...Question[]];

type ChoiceAnswer =
  | Readonly<{ type: 'choice'; choiceId: string }>
  | Readonly<{ type: 'custom'; value: string }>;

type QuestionAnswer =
  | Readonly<{ type: 'text'; value: string }>
  | Readonly<{ type: 'single'; answer: ChoiceAnswer }>
  | Readonly<{
      type: 'multiple';
      answers: readonly [ChoiceAnswer, ...ChoiceAnswer[]];
    }>;
```

An answered result is
`{ status: 'answered', answers: Readonly<Record<string, QuestionAnswer>> }`,
keyed by question `id`. Cancellation is
`{ status: 'cancelled', diagnostic?: PluginDiagnosticData }`; unavailability is
`{ status: 'unavailable', diagnostic: PluginDiagnosticData }`. Custom values
are the provider-neutral “Other” answer; provider-native adapters preserve
their own answer semantics behind this boundary.

## Agent runtimes

Register native `AgentRuntime` implementations from
`@happier-dev/plugin-sdk/agent-runtime`. A runtime supplies a `sessions` factory,
an `executionRuns` factory, or both. Happier owns shared session and turn
lifecycle, input custody, transcript persistence, activity, and process-terminal
state; the plugin supplies Agent-native commands, codecs, correlation, and
authoritative evidence.

## Plugin UI

- Declarative surfaces are validated and rendered by the host.
- Hosted web surfaces are isolated UI and use the public bridge.
- React Native surfaces are trusted client code and are the default
  native-feeling executable UI model.

Hosted web isolation does not sandbox daemon code. Installation is a
whole-package **Install & Trust** decision.

Hosted web code constructs its client from the injected bootstrap at the exact
public path:

```ts
import { createPluginUiHostApiClient } from '@happier-dev/plugin-sdk/ui/client';

const host = await createPluginUiHostApiClient();
```

React Native code instead exports a `PluginUiRenderSurface` from
`@happier-dev/plugin-sdk/ui`. The host passes its `PluginUiRenderContext`,
including the already-bound `hostApi`, directly; React Native renderers do not
use the hosted-web bootstrap client.

Build UI with public helpers from `@happier-dev/plugin-sdk/ui/build`; the host
verifies the emitted artifact manifest and content before use.

## Testing

```ts
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import manifest from '../.happier-plugin/plugin.json';
import * as module from '../src/index';

const plugin = await createPluginTestkit({ manifest, module });
await plugin.invokeAction('echo', { text: 'hello' });
await plugin.dispose();
```

The testkit validates the manifest, activates the module, enforces declared
registration ids, invokes actions, and runs cleanup. It is not a substitute for
packing and exercising install, trust, development, update, UI, and uninstall
flows in a real host.

Canonical author docs live in `apps/docs/content/docs/plugins/`. Source examples
under this package are compile fixtures; the CLI scaffold and cold manifest are
the external authoring source of truth.

## Repository validation

From the Happier repository root:

```bash
yarn workspace @happier-dev/plugin-sdk test
yarn workspace @happier-dev/plugin-sdk typecheck
yarn workspace @happier-dev/plugin-sdk build
```

Publication also requires a packed tarball and out-of-repository proof; workspace
links are not release evidence.
