# Composer external dogfood

This is the r1.0 external issue-attachment plugin used to prove the public Composer contract. It is intentionally not a scaffold or a first-party source fixture.

Its packed check accepts the publisher-issued current SDK and Plugin UI tarball paths directly. In a clean external workspace it installs that exact pair first, verifies their physical package roots, installs the fixture's declared framework/tool dependencies second, and only then copies, builds, and packs the fixture. The resulting three archives are installed in another empty external consumer. It reports the exact consumed pair in command output only; it creates no candidate manifest, freeze, receipt, or artifact registry. The fixture has no private workspace, Protocol, CLI, or UI-app import path.

The fixture's manifest selects one real React Native renderer artifact for its picker, compact attachment display, rich preview, and before-Composer region. Its compact renderer and picker obtain the host-stamped mounted handle through the public Plugin UI `useComposer().current()` facade; author code never parses or accepts `launchInput.composer` as a Composer carrier. The picker reads that handle and applies one revision-checked, contentless issue attachment. Its UI-origin EU6 path calls that exact handle's public `content.pickMedia`, bounded `inspect`, and explicit `release`, then carries the host-returned opaque handle unchanged in the attachment-add operation's staged `content` field. Its daemon-origin EU6 path queues the same `issue-media` attachment without content; the host-bound public attachment `prepareForSend` callback writes fixture bytes to a plugin-data `PluginPath`, calls `context.services.composerContent.stageMedia`, and returns the opaque staged handle only on the ready outcome. Existing staged content passes through unchanged, while failed or unavailable outcomes contain no content. The fixture never stamps a host path, URI, target, owner, digest, or transfer identity. The display and preview consume the same persisted attachment identity and immutable fallback presentation; the host still owns the row and remove affordance.

The source harness covers all four independent Composer contribution families, the mounted control-to-picker mutation seam, exact-Session no-control attachment injection, mounted EU6 pick/inspect/staged-add/release behavior, daemon-origin contentless queueing, public attachment-runtime registration, preparation retry/cancellation, post-acceptance observation, fresh dispatch resolution, surface retirement/stale-target rejection, reinstall remount from unchanged input, and the immutable contentless fallback record. It deliberately does not substitute fake host services to execute daemon staging. Source testkit retirement does not pretend to be host installation lifecycle: real daemon staging and transfer, new-Session/remote-target finalization, restart/cancel/retry/corruption, update/uninstall/reinstall, host-row fallback, and transcript replay remain controlled loaded-runtime QA. The fixture deliberately excludes r1.1+ host attachment identity, focus identity, generic-file, Browser, Review, and incumbent-domain migration authority.

The direct-tarball run builds the fixture's web/iOS/Android UI artifact siblings during the canonical pack, installs the SDK, Plugin UI, and fixture archives in an empty consumer, rejects nested or workspace substitutions for the supplied pair, requires the exact generated artifact graph and bytes, executes the public SDK semantic test, compiles NodeNext/Vite/Metro authoring, and loads the UI entry through Vite. It does not replace loaded host QA: real control projection, host-row persistence/removal, durable-admission timing, queue-delay resolution, existing/new Session sends, transcript replay, and update/uninstall behavior still require the composed Happier runtime.

For the loaded daemon proof, install the packed fixture through the incumbent external-plugin journey, open its mounted external issue picker, choose **Attach daemon-origin image evidence for Issue EXT-84**, and submit the Composer. Verify that the installed plugin's `issue-media` attachment preparation runs on the target daemon, the send succeeds with one host-stamped staged-media identity, and the admitted message/transcript retains that identity. This is the deciding execution evidence for the public `services.composerContent.stageMedia` call; source, declaration, and packed smoke checks prove the maintained route but do not claim to invoke that host service.

Run only after the sole publisher has produced the current SDK/Plugin UI pair:

```sh
node packages/tests/scripts/plugin-platform/run-packed-composer-external-dogfood.mjs \
  --sdk-tarball /absolute/path/to/happier-dev-plugin-sdk.tgz \
  --plugin-ui-tarball /absolute/path/to/happier-dev-plugin-ui.tgz
```

The fixture package wrapper accepts the same direct pair through
`HAPPIER_COMPOSER_DOGFOOD_SDK_TARBALL` and
`HAPPIER_COMPOSER_DOGFOOD_PLUGIN_UI_TARBALL`, and prints the same provenance.

```sh
HAPPIER_COMPOSER_DOGFOOD_SDK_TARBALL=/absolute/path/to/happier-dev-plugin-sdk.tgz \
HAPPIER_COMPOSER_DOGFOOD_PLUGIN_UI_TARBALL=/absolute/path/to/happier-dev-plugin-ui.tgz \
corepack yarn --cwd packages/tests/fixtures/plugin-platform/composer-external-dogfood pack:fixture
```
