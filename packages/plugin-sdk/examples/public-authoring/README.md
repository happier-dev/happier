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
deferred, conformance-only surfaces. They intentionally remain here to exercise
their declared SDK shape, not to claim a supported product lifecycle.

The React Native artifact is one package graph for web, iOS, Android, and
desktop. The hosted-web artifact is a declared multi-file graph: its entry
waits for the host-issued ready/bootstrap lifecycle through the public
`createPluginUiRenderContext()` API, reads the package's `review-guide`
Resource through `hostApi.readResource`, and never parses launch facts from a
URL or reaches into a parent frame.

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
shape. It does **not** claim a packed archive, package-load, loaded Artifact
adoption, or browser, iOS, or Android proof. Those rows run independently on
the exact package/Artifact and loaded runtime identities they exercise through
the canonical Artifact frame owner; there is no global fixed candidate. Do not
substitute a source URL, dev server, loopback server, or private host bridge.

It is advanced reference material, not the ordinary starting path. Prefer the
CLI scaffold and `definePlugin(...)` for a normal plugin. For a compiled
`definePlugin` package-root reference with a custom Session Agent and distinct
runner leaf, see `../advanced-package-root/`.

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

Run its package-local lifecycle through the canonical author and packed-test
owners:

```bash
happier plugins author typecheck .
happier plugins author build .
happier plugins test .
happier plugins test . --packed
```

The packed command is the later archive/package-load gate: it creates an
archive, trusts and installs it into a disposable daemon, restarts that daemon,
and invokes this package's empty-input `review-summary` Action. Run it only
when the canonical publisher/artifact is available. It is package/load evidence
only, not mounted-host or settled-candidate proof.

Start a normal plugin with the smaller scaffold:

```bash
happier plugins create my-plugin
cd my-plugin
happier plugins dev
```
