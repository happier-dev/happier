# Surface state composition

Use one state composition for a page, pane, details area or compact list line. A surface explains what is happening and offers the next useful action; retained data stays visible while its owner refreshes it.

This page describes **0.3 development source**, not completed platform or live-fidelity certification.

## Core and shared owners

The app consumes [`SurfaceStateCard`](../apps/ui/sources/components/ui/surfaces/SurfaceStateCard.tsx) through `@/components/ui/surfaces`. It admits empty, loading, success, error, warning, unavailable and denied states, with translated title/reason, a primary action, optional quiet secondary action, note/help, present-tense live information and diagnostic details.

[`SurfaceStateSizeProvider`](../apps/ui/sources/components/ui/surfaces/surfaceStateSize.tsx) sets `pane`, `details`, `page` or `phone` once at the container. A card's explicit size wins; outside a provider the existing unsized composition remains. `size="line"` is the compact in-list composition. Shared size/type/line metrics come from [`presentation/state/InfoState.tsx`](../packages/plugin-ui/src/presentation/state/InfoState.tsx); change that owner rather than hand-sizing a consumer.

Plugins use the public Plugin UI state components. Both adapters consume the shared state frame, compact line and diagnostic disclosure renderers in `InfoState.tsx`; placement and disclosure are not consumer-owned copies. App-specific `SurfaceStateCard` is a host composition, not permission to import app internals into a plugin or claim all its props exist on each public component. Exact public props are package-owned. Public `ErrorState` distinguishes error, unavailable and denied states and supports compact lines. Static failure states stay silent by default; a caller can explicitly request an announcement for a lifecycle transition, without announcing the diagnostic disclosure again.

Notices above retained content share [`HappierBanner`](../packages/plugin-ui/src/presentation/content/Foundation.tsx): the app's `AttentionBanner` binds its theme, actions and diagnostic disclosure, and the public `Banner` binds plugin text and glyphs. The shared renderer owns the tint, outline and responsive action placement. Whole-surface states continue to use the state-card composition.

Progress and capacity bars share `HappierProgress` in the same presentation module. The app's `MeterBar` supplies the domain's fill and colours; a capacity meter stays silent while named progress reports its value. Numbered setup and checklist markers share [`HappierStep`](../packages/plugin-ui/src/presentation/content/Step.tsx) and its marker renderer. Adapters retain their own step decisions, labels, actions and details.

## Surface material (development)

Public Plugin UI `Surface` and `Card` accept `materialRole="chrome" | "sidebar" | "content" | "floating"`;
the default is `content`. They consume the existing shared `HappierSurface` presentation owner.
The same-realm host renders native material through its incumbent glass owner. Unhosted native
surfaces retain their base color. Web background paint consumes the host's role opacity variables,
with an opaque default when that projection is absent; text and child controls do not inherit a
material opacity. Nested surfaces of the same role consume a separate nested coat projection to
avoid accumulating tint. Material presets, preferences, OS overrides and native availability stay
host-owned; the public role does not introduce another material policy or a wire capability.

The app's policy is [`glassMaterial.ts`](../apps/ui/sources/components/ui/glass/glassMaterial.ts),
with one Account-synced table for chrome, sidebar, content and floating surfaces. Solid removes
glass; Auto uses the W3 layered whole-app coats on a supported desktop and floating surfaces on
phone/browser; Everywhere uses one uniform coat. Custom opacity runs from fully transparent to
solid without legibility floors or contrast overrides. Code, terminal, diff, composer and message
backgrounds inherit the content material rather than introducing near-solid reading fills.
The phone's floating composer, including a selected workflow, instead consumes the floating
material; ordinary dialogs and sheets use the same floating owner through `ModalCardFrame`.
Native material changes replace only the background, preserving child input/scroll state.
OS Reduce Transparency preserves the stored choice but resolves solid with a visible reason.
Desktop and Android expose the OS accessibility destination with an observable failure result;
an honest iOS settings destination remains unresolved in the current build lane. Browsers observe
the standard reduced-transparency media query where available. Native inactive windows also
flatten. The main-window owner reports successful
native backing before the web root clears its opaque canvas. Blur Off can retain transparent
backing. The 0.2 enable/intensity keys remain inputs; the old device-local backdrop switch is no
longer a second runtime decision.

## Retained content and recovery

[`SurfaceFreshnessLine`](../apps/ui/sources/components/ui/surfaces/SurfaceFreshnessLine.tsx) presents the retained observation's time, refresh/reconnect reason and optional recovery action. Show it alongside retained content, under the header; when there is no retained content, show the appropriate loading/error/unavailable card instead. It and the public Plugin UI freshness component consume the same `HappierFreshnessLine` renderer and freshness-text formatter. Domain adapters still own observation timestamps and recovery actions.

Loading narration and diagnostic disclosure belong to the composition. The card does not own retries, availability, permissions or the underlying request lifecycle. Supply truthful state from that domain's owner, stop live activity at its terminal outcome and keep technical codes behind details. Avoid a second consumer-local spinner/error parser or timer for the same work.

Plugin Resource hooks retain their store snapshot when host mount activity turns inactive, release their read/watch subscription, and refresh through the same owner when activity resumes. Providers without a host activity fact keep their existing live behavior. Imperative `hostApi.watchResource` subscriptions remain caller-owned until disposal; view consumers should use the Resource hooks rather than create another presentation-driven polling lifecycle.

## Related

[Collection presentation](collection-presentation.md), [Plugin platform](plugin-platform.md), [DESIGN.md](../DESIGN.md), [UI instructions](../apps/ui/AGENTS.md).
