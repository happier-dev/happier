# Composer external dogfood

This is the r1.0 external issue-attachment plugin used to prove the public Composer contract. It is intentionally not a scaffold or a first-party source fixture.

Its source checks consume the current SDK and Plugin UI projections through their public entry points. The fixture has no private workspace, Protocol, CLI, or UI-app import path, and its loaded lifecycle runs through the existing managed development stack.

The fixture's manifest selects one real React Native renderer artifact for its picker, compact attachment display, rich preview, and before-Composer region. Its compact renderer and picker obtain the host-stamped mounted handle through the public Plugin UI `useComposer().current()` facade; author code never parses or accepts `launchInput.composer` as a Composer carrier. The picker reads that handle and applies one revision-checked, contentless issue attachment. Its UI-origin EU6 path calls that exact handle's public `content.pickMedia`, bounded `inspect`, and explicit `release`, then carries the host-returned opaque handle unchanged in the attachment-add operation's staged `content` field. Its daemon-origin EU6 path queues the same `issue-media` attachment without content; the host-bound public attachment `prepareForSend` callback writes fixture bytes to a plugin-data `PluginPath`, calls `context.services.composerContent.stageMedia`, and returns the opaque staged handle only on the ready outcome. Existing staged content passes through unchanged, while failed or unavailable outcomes contain no content. The fixture never stamps a host path, URI, target, owner, digest, or transfer identity. The display and preview consume the same persisted attachment identity and immutable fallback presentation; the host still owns the row and remove affordance.

The source harness covers all four independent Composer contribution families, the mounted control-to-picker mutation seam, exact-Session no-control attachment injection, mounted EU6 pick/inspect/staged-add/release behavior, daemon-origin contentless queueing, public attachment-runtime registration, preparation retry/cancellation, post-acceptance observation, fresh dispatch resolution, surface retirement/stale-target rejection, reinstall remount from unchanged input, and the immutable contentless fallback record. It deliberately does not substitute fake host services to execute daemon staging. Source testkit retirement does not pretend to be host installation lifecycle: real daemon staging and transfer, new-Session/remote-target finalization, restart/cancel/retry/corruption, update/uninstall/reinstall, host-row fallback, and transcript replay remain controlled loaded-runtime QA. The fixture deliberately excludes r1.1+ host attachment identity, focus identity, generic-file, Browser, Review, and incumbent-domain migration authority.

The source integration run builds the fixture's web/iOS/Android UI outputs, rejects private or nested workspace substitutions, executes the public SDK semantic test, compiles NodeNext/Vite/Metro authoring, and loads the UI entry through Vite. Loaded host QA still covers real control projection, host-row persistence/removal, durable-admission timing, queue-delay resolution, existing/new Session sends, transcript replay, and update/uninstall behavior through the composed Happier runtime.

For the loaded daemon proof, load the fixture through the incumbent managed
source-development journey, open its mounted external issue picker, choose
**Attach daemon-origin image evidence for Issue EXT-84**, and submit the
Composer. Verify that the plugin's `issue-media` attachment preparation runs on
the target daemon, the send succeeds with one host-stamped staged-media
identity, and the admitted message/transcript retains that identity. This is the
deciding execution evidence for the public
`services.composerContent.stageMedia` call; source and declaration checks prove
the maintained route but do not claim to invoke that host service.

## Discussion QA installation (0.3 development source)

This is a preparation recipe, not a loaded-runtime PASS. N2 QA last observed
only bundled plugins on `agent-qa-coord-n2`; the standalone Discussion helper
does not establish that an installed UI invokes it. Do not run this recipe
without the QA owner's installation authorization. It does not require a
release archive, a second registry, copied credentials, or a stack restart.

Before preparation, require the current public SDK/Plugin UI development
dependencies to be prepared, and the fixture's source acceptance checks to be
GREEN. In particular, the fixture must have all three canonical entry points:

- `src/index.ts` re-exports `manifest` and `activate` from `src/index.mjs`.
  The directory author loader discovers `src/index.ts` or `index.ts`, **not**
  `package.json#main`. Source evaluation stamps `entrypoints.development`.
  The public definition also declares `entrypoints.daemon: './dist/daemon.mjs'`:
  the canonical author build bundles this actual executable output. Do not add
  an entry only to the generated manifest or point it at nonexistent bytes.
- `tsconfig.json` uses the strict `tsconfig.public.json` contract. Managed
  `plugins dev build` invokes TypeScript with `-p tsconfig.json` before UI build.
- The exact package export `./happier-plugin-ui/issue-surface-native` points to
  `src/issueSurface.mjs`, which exports the canonical named `renderSurface`.
  Public artifact discovery requests that name for React Native renderers;
  `ISSUE_SURFACE_REPACK_MODULE` metadata from a packed-test harness is not a
  production builder input. No separate UI build configuration is needed.

The declared `inspect` control must select the `discussion-surface`
renderer, reusing `issue-surface-native`, and be restricted to Discussion
scope. Stop if these source prerequisites are absent or the public build
fails; do not substitute a fake host API or inject a bundled contribution.

### Prepare, synchronize, and register

Run the following from this repository root after those prerequisites and
installation authority are satisfied. The first producer imports the current
public SDK from the controller's prepared dependency tree and writes this
fixture's `.happier-plugin/plugin.json`; it is not the `prepack` script.

```sh
node packages/tests/fixtures/plugin-platform/composer-external-dogfood/scripts/write-manifest.mjs
node ./apps/stack/scripts/repo_local.mjs stack info agent-qa-coord-n2 --json
node ./apps/stack/scripts/repo_local.mjs dev-targets show nl1 --stack=agent-qa-coord-n2 --json
node ./apps/stack/scripts/repo_local.mjs dev-targets status nl1 --stack=agent-qa-coord-n2 --json
node ./apps/stack/scripts/repo_local.mjs dev-targets sync nl1 --stack=agent-qa-coord-n2
node ./apps/stack/scripts/repo_local.mjs stack happier agent-qa-coord-n2 --runtime=source -- plugins dev install /home/happier/happier-dev/packages/tests/fixtures/plugin-platform/composer-external-dogfood --json
node ./apps/stack/scripts/repo_local.mjs stack happier agent-qa-coord-n2 --runtime=source -- plugins dev build /home/happier/happier-dev/packages/tests/fixtures/plugin-platform/composer-external-dogfood --json
node ./apps/stack/scripts/repo_local.mjs stack happier agent-qa-coord-n2 --runtime=source -- plugins install /home/happier/happier-dev/packages/tests/fixtures/plugin-platform/composer-external-dogfood --dev --json
node ./apps/stack/scripts/repo_local.mjs stack happier agent-qa-coord-n2 --runtime=source -- plugins status --json
node ./apps/stack/scripts/repo_local.mjs stack happier agent-qa-coord-n2 --runtime=source -- plugins show acme.composer.issue-dogfood --json
```

Confirm `stack info` still places the healthy QA daemon on `nl1`, with the
expected selected/loaded source identity, before mutation. The read-only
target inspection on 2026-10-19 returned `repoDir: /home/happier/happier-dev`.
Re-derive the qualified path if placement/configuration changes. The stack
wrapper forwards to the observed daemon host and starts in its repository
root; it does **not** upload or rebase a controller filesystem argument or
retain the controller's fixture working directory. Thus the qualified install
above is the remote equivalent of `happier plugins install . --dev --json`
inside the authenticated nl1 fixture directory. Neither controller `.` nor
`/home/leeroy.guest/...` names that source remotely.

Canonical source synchronization carries the fixture source and cold manifest;
`node_modules` and `dist` are target-local outputs. `dev install` is explicit
external-fixture dependency preparation, **not** runtime registration. It uses
Happier's managed dependency materializer; SDK version `0.0.0` resolves through
the running CLI, without workspace aliases or an ad hoc registry. `dev build`
then produces the UI artifact on nl1 through the public builder. Do not run
`prepack`, `pack:fixture`, `plugins pack`, or a local archive install for this
source QA journey. After source edits, regenerate the cold manifest and sync;
use the same stack wrapper with `plugins reload acme.composer.issue-dogfood
--json`, not a second watcher or loader.

This manifest-transfer claim was checked against the live `happier-nl1`
session's effective filter on 2026-10-19, not inferred from Git tracking:
`packages/plugins/*/.happier-plugin` is excluded, but this `packages/tests`
fixture's `.happier-plugin` is not. Recheck `dev-targets status` if routing or
filters change. Development installation can also evaluate `src/index.ts`
directly and pass a temporary manifest to its owned UI build, without any cold
manifest transfer. It does not persist that temporary manifest into the author
root; the standalone `plugins dev build` above still needs this fixture's
explicit cold-manifest producer. The reload parser accepts the explicit
installed plugin ID and requires that record to be a development path source.

Explicit `install --dev` trusts only the exact requested source; it grants no
optional host resources. A mismatched review cancels with
`plugin_explicit_trust_target_mismatch`. If an ordinary install approval remains
pending, inspect the daemon-evaluated review in Inbox and rejoin by repeating
the exact install command, preserving its approval Artifact. The same wrapper
can run `plugins change status <pendingChangeId> --json` for inspection, or
`actions invoke approval.request.decide --input-json
'{"artifactId":"<approvalArtifactId>","decision":"approve"}' --json` for an
authorized decision. The approval Artifact ID is not the pending change ID.
After `expired`, repeat the original request; after `outcome_unknown`, inspect
installed state before retrying. Failed replacement keeps an incumbent only
within the same daemon lifetime; correct the source rather than restarting it.

### Exercise the installed Discussion control

Require `plugins status`/`show` to report this external development source and
its current occurrence without admission errors; a successful terminal exit or
the old bundled-plugin count is insufficient. In the same QA Account/Home UI,
select this plugin's real nl1 execution origin through Administration if
selection is needed, open an actual Discussion, and open its plugin chip.
The fixture accepts the actual invited receiver's Session ID, not an invented
Session/Machine. Exercise public mounted-handle read/watch, focus and lock/
unlock, then Apply the typed `@Reviewer Check this` reference. Verify that the
normal controlled Discussion draft contains the reference and that edits are
locked only for the held lock; close/unmount releases the subscription/lock.
Finally the human presses Happier's existing **Send**, not a plugin Send button.

The UI obtains only the host-stamped `useComposer().current()` handle, never a
handle inferred from `launchInput.composer`. Check that the control is absent
from Session composers and retires on plugin withdrawal or scope change.
Capture the committed addressed human question through canonical Discussion
readback. Actual native intake and one attributed receiver reply remain the U2
loaded-runtime acceptance prerequisite; this recipe and source GREEN do not
claim that reply, watch lifecycle, or installed UI passed live.
