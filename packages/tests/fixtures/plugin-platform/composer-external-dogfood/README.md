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
