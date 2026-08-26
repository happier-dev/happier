# Public SDK Conformance Companion

This is the deliberately broad conformance companion to the minimal CLI
scaffold. It demonstrates a safe Action, immutable packaged Resource, bounded
Composer references, a revision-bound openable-content viewer, a Session-scoped
Account-backed dynamic Resource, tools, commands, hooks, a native Agent
runtime, settings, React Native and hosted-web UI, and Voice declarations in
one package. It is not the portfolio's
production React Native or hosted reference. Those distinct packages are the
first-party Inspector and `../production-hosted-reference/`; this combined
package remains a verification companion for the public SDK surface.

Before selecting an authoring family, read the installed
`capability-matrix.json`; it is the sole availability authority. The Composer
references, attachments, controls, and regions; `openableContentViewers`;
tools; commands; and Session-header actions in this broad companion are
deferred. They are not supported or advertised for ordinary author use; do not
rely on them; consult each row's unblock condition in
`capability-matrix.json`. Their presence exercises declared SDK shape and
source wiring only; it does not claim public availability. Tools and Commands
need a maintained external development-source proof in the current loaded
development stack before publication metadata can advertise them as usable.

The React Native artifact is one package graph for web, iOS, Android, and
desktop. The hosted-web artifact is a declared multi-file graph: its entry
waits for the host-issued ready/bootstrap lifecycle through the public
`createPluginUiRenderContext()` API, reads the package's `review-guide`
Resource through `hostApi.readResource`, and never parses launch facts from a
URL or reaches into a parent frame.

The mounted React Native **Session** Project Companion activity demonstrates
the source-complete Developer Preview current-UI contract: it publishes bounded
semantic data and an opaque Action command with `publishCurrentUiContext(...)`,
then clears it on unmount through that same Host API. The app-level review
overview does not publish this Session-only command. `currentUiContextMode:
'off'` exposes no current-UI read or command tool and sends no updates;
`'on_demand'` permits an explicit read; and `'automatic'` adds metadata-only
transitions. A read may disclose opaque command descriptors, but command
invocation is a separate effectful capability: the account-mediated
`credentialed-browser` provider declares `effectCalls: 'stable_ids'`. After a
normal text control, it emits the ordinary provider tool-call sequence:
`readCurrentUiContext`, then, after the host returns that tool result and its
normal response continuation, `invokeCurrentUiCommand` using the opaque
command id. Both calls retain stable provider call ids, so the incumbent host
effect barrier owns execution, result delivery, and replay/conflict protection.
It emits no invoke call when the current read has no command and does nothing
on bare connection. The raw browser provider remains `effectCalls: 'none'`. The `open-review-status`
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
distinct STT and TTS runtimes. The raw-capable browser declaration is
intentionally fail-closed in this source proof until the generic credential
permission materializer is integrated.

`definition.ts` is the sole projected source of truth. `index.ts` applies
`definePlugin(publicAuthoringDefinition)`; the canonical author build projects
the staged `.happier-plugin/plugin.json` and emits the declared
`dist/daemon.js` entrypoint. There is no handwritten manifest or manual daemon
`activate(api)` beside that definition. Its Session runner locator names the distinct
`agent/runtime.ts` factory leaf. A runner imports that leaf rather than calling
`activate`; these can be different realms and must not share a process-global
singleton.

Run its package-local lifecycle through the canonical managed source-author
owner:

```bash
happier plugins dev typecheck .
happier plugins dev build .
happier plugins test .
happier plugins dev
```

Use the existing development stack for daemon restart, invocation, mounted-host,
and lifecycle QA. Do not create a separate release representation.

Start a normal plugin with the smaller scaffold:

```bash
happier plugins create my-plugin
cd my-plugin
happier plugins dev
```
