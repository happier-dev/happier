# Public SDK Conformance Companion

## Packaged Bot templates (0.3 development source)

[`botTemplates.ts`](botTemplates.ts) declares two cold `botTemplates` entries
through the public SDK. Their [packaged JSON](templates/researcher.json) contains
BT2 releases, with no private draft or source identity. Include the declared
files in the published package. This fixture proves descriptor authoring and
BT2 parsing, not Store availability; check the generated capability matrix for
the target host. Reading a selected release does not activate the plugin.

## Team documents through Artifacts (0.3 development source)

[`teamArtifacts.ts`](teamArtifacts.ts) creates a document through the invocation's
`services.actions.execute('artifact.create', ...)`, grants a Team edit access
with `artifact.access.grants.set`, and reads/updates it using a recipient's own
invocation. Import `createTeamDocument` and `updateTeamDocument` from this
example, and `isPluginActionApprovalRequestCreated` from the public SDK:

```ts
const created = await createTeamDocument(context.services.actions, teamId, {
  header: { title: 'Team notes' }, body: 'First draft',
}, { signal: context.signal });
if (isPluginActionApprovalRequestCreated(created)) return created;
if (isPluginActionApprovalRequestCreated(created.sharing)) return created;
// In the recipient's invocation:
return updateTeamDocument(recipient.services.actions, created.artifactId, 'Reviewed draft');
```

An approval deferral is not an executed write. A deferred create returns the
approval directly and never grants access. A deferred grant returns the created
document's id/revision alongside `sharing`, so keep that id. Use the normal
approval flow to inspect/settle the request; do not restart document creation or
automatically replay an uncertain write. Resume from the acknowledged Artifact
with `artifact.get`. A grant receipt with `preparation.status === 'pending'`
means access changed but recipient key delivery still needs recovery; reopen the
Artifact as a key holder and inspect its access before claiming it is readable.

Plain Accounts require no encryption keys. E2EE content and recipient key
envelopes stay with the host's Artifact owner; the example never handles keys.
A recipient without usable E2EE material receives the host's typed
`artifact_encryption_material_unavailable` failure and performs no update.
The update uses the read's revision; surface a conflict for the person to reload
and reconcile rather than silently overwriting another edit. A missing Artifact
returns `{ artifact: null }` without writing.

Use Account Collections for private indexed plugin state. A Team grant on a
document does not grant deployment/execution authority or shared Collections.
The composed source test is
`apps/cli/src/api/artifacts/teamArtifactAuthorExample.composed.test.ts`; its Home
HTTP fixture retains the real Artifact codecs, Team grant preparation and
recipient opening/update owners for Plain and E2EE.

In 0.3 development source, `session-skill-reference` demonstrates the existing
Session `rightSidebarTab` slot. Its `ui/sessionSkill.tsx` reads an explicitly
chosen skill with the typed `skills.read` host Action and renders the acknowledged
library record through `HappierSavedSkillCard` from
`@happier-dev/plugin-ui`. Opening the pane performs no read; the
person requests it with Read skill. The card says that runtime application has
not been inspected, rather than treating readable or saved content as live.
Copy instructions uses the mounted host clipboard Action. Creator presentation
and reach/application controls remain with the host's canonical owners.

For localized label data in unreleased 0.3 source, keep the template and scalar
values together and let the host's existing translation owner select the locale:

```ts
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/plugin-sdk/manifest';

const label = {
  key: 'review.continue',
  fallback: 'Continue {count} more · {pullRequest}',
  params: { count: 7, pullRequest: 'example/repository#1' },
};
const frozenText = resolvePluginLocalizedStringV2Text(label);
const localizedText = resolvePluginLocalizedStringV2Text(label, '{pullRequest} : encore {count}');
```

The first result is `Continue 7 more · example/repository#1`; the second is
`example/repository#1 : encore 7`. Values are plain strings or numbers, not
formatting or executable expressions. Literal labels remain literal. An older
strict host rejects `params`; check the target host and its `engines.happier`
range rather than treating this example as released availability. See
[localized labels](https://docs.happier.dev/plugins/manifest#localized-labels-03-development-source).

The source-controlled test suite demonstrates `createPluginClientTestkit` for
one declared client artifact/export/platform, then retrieves its typed Action
registration and disposes activation. It also demonstrates read observation
without invoking the handler and the fixed unavailable-transport error fixture.
These are 0.3 development-source test helpers; they do not establish installed
artifact loading or real-host admission.

`appRegistrySourceAuthoring` demonstrates the unreleased 0.3 app-source
declaration with both credential-free HTTPS and inert packaged data. The
`packageContent.path` points to `resources/registry/apps.json` within this
package. The host reads it through the installed supplier's current plugin
version and occurrence, then validates only the selected descriptor. It does
not import or activate this example to browse or read an app. The small data
fixture illustrates the catalog envelope; it is not a production database
deployment recommendation.

In 0.3 development source, `machinePageAuthoring.readMachinePageTarget` returns
the current mounted Machine's routing ids and, when established by the host,
verified `homeId` and enrolled `installationId`. Pass those explicit facts to
controller-addressed host Actions. Contributed plugin Actions still use the
plugin's selected execution origin; this reader neither relocates execution nor
grants control. The public UI testkit checks exact ids, retirement and refusal of
a Services-panel context.

`machinePageAuthoring.openMachineConfiguration(host, provisioner, signal)` calls
the public `host.openManagedMachineConfiguration({provisioner}, {signal})` from
that Machine page. The host derives the current Home/controller and validates
the provisioner before opening its existing draft/review. It creates no Machine
and performs no native acquisition; no route or controller is authored here.

In 0.3 development source, `healthNoticeAuthoring.readServiceHealthEvidence`
demonstrates the public `/protocol` projections of the host's service-health
notice source/page and authenticated private-notice reader. Pass a fresh
`artifact.get` result and the admitted mount's Account id, not an Account id
from notice content. Foreign, shared, incomplete or mismatched notices return
`null`. The result is evidence only: configured Triage re-admits the exact
service/Machine before using ordinary Session authoring. This example neither
observes health nor creates a Session, watch, approval or service operation;
it does not claim released health-monitoring availability.

`healthNoticeAuthoring.readEnvironmentInvestigationSelection` demonstrates the
same canonical parser for a fresh `deployments.environments.get` response and
an explicitly chosen Machine. An Environment page supplies no implicit Machine;
the parsed values still pass through configured Triage's access, current-link
and placement admission. They do not authorize a Session or select a controller.

Client Actions read the same admitted identity from
`await context.ui.context({ signal: context.signal })`. An absent `accountScope`
means private evidence is unavailable. The scope is an identity hint, not an
authorization grant. `context.ui.openNewSession` accepts the canonical seed,
including `agentTarget`, `profileId`, an exact Machine `placement` and
`directoryIntent: { kind: 'managed' }`. The host writes and opens its ordinary
draft before this promise resolves. Configured Triage's later
`composed/newSessionDraft` result acknowledges that operation; its caller does
not create a second draft.

In 0.3 development source, `accountActionAuthoring` demonstrates the portable
Account Action context. `accountScope` and `sessionTargetsV1` are host-stamped
facts, not Action input. The example reads one explicitly named Session through
`session.status.get` and its admitted address; missing scope or an unadmitted
Session returns no proof. The ordinary status may include `agentTarget` and an
explicitly requested `acceptedWorkspace`; neither is inferred from display
paths. An optional `ui` capability composes the normal draft when a UI invoked
the same handler. A headless invocation does not acquire a composer or a second
Session lifecycle. These examples do not establish released availability.

This is the deliberately broad conformance companion to the minimal CLI
scaffold. It demonstrates a safe Action, immutable packaged Resource, bounded
Composer references, a revision-bound openable-content viewer, a Session-scoped
Account-backed dynamic Resource, tools, commands, hooks, a native Agent
runtime, settings, React Native and hosted-web UI, and Voice declarations in
one package. It is not the portfolio's
production React Native or hosted reference. Those distinct packages are the
first-party Inspector and `../production-hosted-reference/`; this combined
package remains a verification companion for the public SDK surface.

The exported `backupDestinationAuthoring` companion in `index.ts` demonstrates
the **0.3 development-source descriptor seam**: a recursively closed nonsecret
S3 configuration, canonical credential roles, explicit unknown locality and
qualified `test` / `open` Action refs through `definePlugin`. The same activation
ABI binds those ordinary Actions; there is no destination registration callback.
Both Actions return the example-owned `example_has_no_native_transport` result.
They perform no probe or credential access and return no locator, bytes or argv.
This is an executable authoring reference, not configure/backup/restore support.
An actual test must own its exact bounded write/read/delete probe and cleanup in
that invocation, retaining the owned key/recovery facts on cleanup failure.
An actual open returns validated backend facts and opaque admitted binding
handles only. Those runtime contracts wait for the canonical runner and custody
owners; this example introduces no substitute service. See the
[contribution guide](https://docs.happier.dev/plugins/manifest/contributions#backup-destination-declarations-03-development-source).

The `machineSetupAuthoring` companion declares both unreleased Machine setup
families through the public SDK. Its setup-only Browser bot Preset references
the exact revision of its own fonts recipe and uses the same setup part as
Account/Team Presets. Neither family requires activation or a registration
callback. The host owns native checking, review and execution. This example's
APT package step is for a bot's own tools; it does not change Happier Browser's
managed Chromium. Installed-author conformance reads the software option from
the installed projection, prepares the bundled Preset through the receiving
Machine's `machines.setup.plan`, and runs the expanded plan through the host
interpreter, including a no-op reapply and unavailable-revision refusal. It
does not prove the full attached-Preset Apply flow or live native support. Consult the
[Machine setup author contract](https://docs.happier.dev/plugins/manifest/contributions#machine-setup-declarations-unreleased-development-contract)
and the generated availability matrix before targeting a published host.

In 0.3 development source, `sessionSectionAuthoring.fileReviewSessionInNewSection`
uses the invocation's public `context.services.actions` service to list sections,
create a section and file a Session. Its inputs and results come from the generated
SDK Action type map. A deferred approval stops dependent work; a failed or unknown
write is not replayed. The host retains Account scope and policy. Run the normal
source author build and tests below; this is not a shipped availability claim.

The development `reviewExactDeploymentSource` companion consumes the public
source port using only the admitted Environment/Deployment identities. It
returns a value-free immutable manifest fingerprint and aborts its uncommitted
staging. `runDeploymentRuntimeProbe` demonstrates the matching opaque runtime
environment attachment; neither helper receives requester/workspace authority,
an alternate repository path or an environment-value getter.

Before selecting an authoring family, read the installed
`capability-matrix.json`; it is the sole availability authority. Composer
references, attachments, controls, and regions, and Session-header actions are
available in the current Developer Preview source;
the matrix separately records that loaded-platform proof and publication are
still open. `openableContentViewers`, Tools, and Commands remain deferred and
are present here only to exercise their declared SDK shape and source wiring.
They need a maintained external development-source proof in the current loaded
development stack before publication metadata can advertise them as usable.

The React Native artifact is one package graph for web, iOS, Android, and
desktop. The hosted-web artifact is a declared multi-file graph: its entry
waits for the host-issued ready/bootstrap lifecycle through the public
`createPluginUiRenderContext()` API, reads the package's `review-guide`
Resource through `hostApi.readResource`, and never parses launch facts from a
URL or reaches into a parent frame.

The development `review-project-page` is a real `appPage` targeted at `project`.
It reads the host's accepted logical Project key and optional repository facts,
with no Machine or Resource prerequisite. Its public Collection opens a
`DetailsPane` in the existing Project host column (push on a phone), and the
shared `DetailsPaneOpenAsPageButton` moves the same selection to a local full-page
location through `replacePageLocation`, then returns through that same owner.
The host generates the qualified Project URL. The example does not parse a
remote URL, select a Machine or create a pane controller. Source conformance and
the managed external-author journey must pass before a loaded-platform claim.

The development `review-machine-page` uses the same public surface shorthand
with `target: { kind: 'machine' }` and a declarative text renderer. The exported
`machinePageAuthoring.readMachinePageTarget(host, signal)` companion reads the
exact `{ kind: 'machine', serverId, machineId }` from `host.context()`. It rejects
a Services-panel context and stops working when the host retires the mount.
It does not discover services or choose an execution Machine. The text renderer
is a conformance fixture; it is not the Docker Sandboxes page. Machine-shell
placement and installed-plugin loaded-runtime proof remain separate integration
work, with no released-availability claim.

The mounted React Native **Session** Project Companion activity demonstrates
the source-complete Developer Preview current-UI contract: it publishes bounded
semantic data and an opaque Action command with `publishCurrentUiContext(...)`,
then clears it on unmount through that same Host API. The app-level review
overview does not publish this Session-only command. `currentUiContextMode:
'off'` exposes no current-UI read or command tool and sends no updates;
`'on_demand'` permits an explicit read; and `'automatic'` adds metadata-only
transitions. A read may disclose opaque command descriptors, but command
invocation follows canonical Action approval. After a
normal text control, it emits the ordinary provider tool-call sequence:
`readCurrentUiContext`, then, after the host returns that tool result and its
normal response continuation, `invokeCurrentUiCommand` using the opaque
command id. Both calls retain stable provider call ids, so the incumbent host
effect barrier owns execution, result delivery, and replay/conflict protection.
It emits no invoke call when the current read has no command and does nothing
on bare connection. The `open-review-status`
Action has one declaration with `ui` and `voice` invocation surfaces and one
web/iOS/Android client target. Its `reviewClientActions.activate(api)` entry
registers the handler once, so it runs only in the invoking client through
`context.ui.openSurface(...)`; it never falls back to the daemon. The separate
`open-review-status-web-only-fixture` retains the web-only Voice artifact only
to demonstrate a typed unavailable platform admission. This remains Developer
Preview documentation: the source test and loaded development-runtime lifecycle
gate must pass before it can be treated as shipped availability.

The Composer portion of `definition.ts` uses the one nested `composer` map and
all four public helper families. `references.review-references` returns one
bounded, cancellable review focus through the public registration API.
`attachments.review-label` is a minimal structural JSON attachment with no
picker, control, runtime callback, binary content, content handle, or media
identifier. `attachments.review-evidence` and
`controls.add-review-evidence` demonstrate a declared picker, while
`regions.review-context` reuses the existing renderer chain after the Composer.
The dedicated `review-text-viewer` destination accepts only a host-issued opaque
`workspaceFile` launch reference, then calls
`statOpenableContent` followed by one revision-bound, 64 KB
`readOpenableContent` request. It does not receive a path, filesystem service,
editor handle, or write capability. Ordinary review panel, Session details, and
activity renderers instead declare only their Resource and Action methods, so a
mount with no openable-content binding is not refused for unrelated methods.

The separate `review-session-status-details` Session view consumes the
`review-session-status` dynamic Resource. Its daemon producer reads and watches
the manifest-declared `review-session-statuses` Account Collection only through
the injected Account storage scope; the UI reads and watches that Resource
through the mounted host API. It has no daemon-local fallback, poller, cache,
or global Session state.

The Session-side Project Companion dashboard is declarative. Its static root
paints before the dynamic `project-companion-dashboard-document` Resource is
available; that Resource emits one strict versioned document from the same
declared Account Collection and invalidation path. The host validates and
atomically adopts each complete candidate. Invalid or reconnecting reads retain
the last known good document rather than replacing the dashboard with a blank
surface.

The `agent-context-companion` hook demonstrates bounded next-turn Agent
composition using the public hook payload and host-stamped Session service. Its
custom `review-agent` composes the prompt Resource and a small identified
instruction, then stores one bounded review cursor/annotation through the public
Session System Records handle. It does not claim that the custom Agent can
execute the declared review tool: the host declares executable tool ids only for
Agents with a real native delivery owner. A separate supported-Agent conformance
case exercises that conditional tool selection. The hook receives neither a raw
runtime nor an underlying store. If its own applicable declarations are
unavailable, it conditionally clears that same record; record conflicts or
temporary failure are local to the annotation and never create a daemon-local
store, cache, or fallback persistence path.

Disable or uninstall stops hook invocation through the host lifecycle; it does
not give the plugin a local cleanup path. On a later eligible invocation (such
as after reinstall), the hook reads the canonical record and uses its revision
for the same public create-or-update call. The activated Session owner decides
record retention and server capability availability.

This reference proves code-defined public authoring and its source build entry
shape. Browser, iOS, and Android rows run independently against the observed
current source and loaded runtime identities they exercise through the canonical
frame owner. Do not substitute a private host bridge or a knowingly stale
runtime.

It is advanced reference material, not the ordinary starting path. Prefer the
CLI scaffold and `definePlugin(...)` for a normal plugin. For the smallest
custom Session Agent and distinct runner leaf, see `../session-agent/`; use
`../advanced-package-root/` when the same package needs its composite Agent,
Provider, Account, Resource, or background capabilities.

The Voice leaves use only the final public `/voice`, `/voice/client`, and
`/voice/speech` subpaths. The browser client entry binds its two conversation
providers in the browser realm; the code-defined daemon activation binds the
distinct STT and TTS runtimes. The raw-capable browser declaration exercises
the generic credential permission materializer at connection time for the
exact declared HTTPS origin and `authorization` header. Raw credential access
does not bypass canonical Action approval.

`definition.ts` is the sole projected source of truth. `index.ts` applies
`definePlugin(publicAuthoringDefinition)`; the canonical author build projects
the staged `.happier-plugin/plugin.json` and emits the declared
`dist/daemon.js` entrypoint. There is no handwritten manifest or manual daemon
`activate(api)` beside that definition. Its Session runner locator names the distinct
`agent/runtime.ts` factory leaf. A runner imports that leaf rather than calling
`activate`; these can be different realms and must not share a process-global
singleton.

The Developer Preview `roles` family is declarative and needs no runtime
registration. For example, a `definePlugin(...)` input can include:

```ts
roles: {
  'security-reviewer': {
    name: 'Security reviewer',
    instructions: 'Review the change for security risks.',
    runsAs: { kind: 'background_run', intent: 'review' },
    workspaceWrites: 'deny',
    secondOpinion: 'off',
    enabled: true,
  },
},
```

The host exposes this read-only source as
`plugin:<pluginId>/security-reviewer`. Users can override its settings through
`rolesV1.overrides`, just like built-in roles; the source stays owned by the
plugin. Optional `engine` and `profileId` fields select execution preferences.
Disabling or uninstalling the plugin makes its roles unavailable, and an
override alone cannot restore the missing source.

Run its package-local lifecycle through the canonical managed source-author
owner (the published copy of this example names the public `happier` command
instead):

```bash
hdev plugins dev typecheck .
hdev plugins dev build .
hdev plugins test .
hdev plugins dev
```

Use the existing development stack for daemon restart, invocation, mounted-host,
and lifecycle QA. Do not create a separate release representation.

Start a normal plugin with the smaller scaffold:

```bash
hdev plugins create my-plugin
cd my-plugin
hdev plugins dev
```
