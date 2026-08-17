import type {
    PluginActionInputById,
    PluginActionResultById,
    PluginInvocableActionId,
} from '../actions/service.js';
import {
    COMPOSER_MEDIA_CONTENT_CAPABILITY_V1 as canonicalComposerMediaContentCapabilityV1,
    MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1 as canonicalMaxComposerAttachmentDescriptionCodePointsV1,
    MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1 as canonicalMaxComposerAttachmentLabelCodePointsV1,
    ComposerContentHandleV1Schema as canonicalComposerContentHandleV1Schema,
    ComposerContentInspectRequestV1Schema as canonicalComposerContentInspectRequestV1Schema,
    ComposerContentPickMediaRequestV1Schema as canonicalComposerContentPickMediaRequestV1Schema,
    ComposerDecorationResultV1Schema as canonicalComposerDecorationResultV1Schema,
    ComposerDecorationSetV1Schema as canonicalComposerDecorationSetV1Schema,
    ComposerFocusResultV1Schema as canonicalComposerFocusResultV1Schema,
    ComposerInputLockRequestV1Schema as canonicalComposerInputLockRequestV1Schema,
    ComposerOperationV1Schema as canonicalComposerOperationV1Schema,
    ComposerReadResultV1Schema as canonicalComposerReadResultV1Schema,
    ComposerRefV1Schema as canonicalComposerRefV1Schema,
    ComposerSurfaceInputV1Schema as canonicalComposerSurfaceInputV1Schema,
    ComposerSnapshotV1Schema as canonicalComposerSnapshotV1Schema,
    ComposerTransactionResultV1Schema as canonicalComposerTransactionResultV1Schema,
    ComposerTransactionV1Schema as canonicalComposerTransactionV1Schema,
    pluginUiTargetedContributionOperationKey as canonicalPluginUiTargetedContributionOperationKey,
} from '@happier-dev/protocol/plugins/ui/client';
export const MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1: number =
    canonicalMaxComposerAttachmentDescriptionCodePointsV1;
export const MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1: number =
    canonicalMaxComposerAttachmentLabelCodePointsV1;
export const COMPOSER_MEDIA_CONTENT_CAPABILITY_V1: ComposerMediaContentCapabilityV1 =
    canonicalComposerMediaContentCapabilityV1;

import type { PluginCancellationOptions, Disposable } from '../lifecycle.js';
import type { PluginDiagnosticData } from '../diagnostics.js';
import type { JsonValue, PluginReference } from '../identity.js';
import type { InteractionSeverity } from '../interactions.js';
import type {
    ComposerAttachmentAuthorValueV1,
    ComposerAttachmentUpdateV1,
    ComposerAttachmentViewV1,
    ComposerCapabilitiesV1,
    ComposerContentHandleV1,
    ComposerContentInspectRequestV1,
    ComposerContentInspectResultV1,
    ComposerContentPickMediaRequestV1,
    ComposerDecorationResultV1,
    ComposerDecorationSetV1,
    ComposerFocusResultV1,
    ComposerInputLockRequestV1,
    ComposerOperationV1,
    ComposerReadResultV1,
    ComposerReferenceSelectorV1,
    ComposerRefV1,
    ComposerSurfaceInputV1,
    ComposerSnapshotV1,
    ComposerTextPositionV1,
    ComposerTextRangeV1,
    ComposerTransactionResultV1,
    ComposerTransactionV1,
    ComposerUnavailableReasonV1,
    ComposerMentionRefV1,
    ComposerMediaContentCapabilityV1,
    OpenableContentBodyV1,
    OpenableContentReadRequestInputV1,
    OpenableContentReadResultV1,
    OpenableContentRefV1,
    OpenableContentStatResultV1,
    PluginUiHostMethodV1,
    PluginUiHostApiSurfaceContextV1,
    PluginUiHostApiSurfaceTargetV1,
    PluginUiHostApiSurfaceThemeV1,
    PluginUiResourceSubscriptionEventV1,
    PluginUiSchema,
    PluginUiSelectedActionInputCarrierV1,
    PluginUiSelectActionInputRequestV1,
    PluginUiSelectActionInputResultV1,
    PluginUiTargetedContributionOperationV1,
    PluginUiTargetedContributionPointSnapshotV1,
    PluginUiTargetedContributionTargetV1,
} from './publicContract.js';

export type {
    ComposerAttachmentAuthorPresentationV1,
    ComposerAttachmentAuthorValueV1,
    ComposerAttachmentPresentationV1,
    ComposerAttachmentUpdateV1,
    ComposerAttachmentViewV1,
    ComposerCapabilitiesV1,
    ComposerContentHandleV1,
    ComposerContentInspectRequestV1,
    ComposerContentInspectResultV1,
    ComposerContentMediaKindV1,
    ComposerContentMimeTypeV1,
    ComposerContentPickMediaRequestV1,
    ComposerDecorationResultV1,
    ComposerDecorationSetV1,
    ComposerFocusResultV1,
    ComposerInputLockRequestV1,
    ComposerOperationV1,
    ComposerReadResultV1,
    ComposerReferenceSelectorV1,
    ComposerRefV1,
    ComposerSurfaceInputV1,
    ComposerSnapshotV1,
    ComposerTextPositionV1,
    ComposerTextRangeV1,
    ComposerTransactionResultV1,
    ComposerTransactionV1,
    ComposerUnavailableReasonV1,
    ComposerSessionMediaContentV1,
    ComposerStagedMediaContentV1,
    ComposerMentionRefV1,
    ComposerMediaContentCapabilityV1,
    PluginUiContainerV1,
    PluginUiContributionIdentityV1,
    PluginUiHostMethodV1,
    PluginUiMountContextV1,
    PluginUiSelectedActionInputCarrierV1,
    PluginUiSelectActionInputTargetedSubmittedV1,
    PluginUiTargetedContributionContributorV1,
    PluginUiTargetedContributionOperationV1,
    PluginUiTargetedContributionPointRefV1,
    PluginUiTargetedContributionPointSnapshotV1,
    PluginUiTargetedContributionProtocolSnapshotV1,
    PluginUiTargetedContributionProtocolV1,
    PluginUiTargetedContributionSelectionV1,
    PluginUiTargetedContributionSurfaceV1,
    PluginUiTargetedContributionTargetV1,
    PluginUiTargetedContributionV1,
    PluginUiTargetedContributionsV1,
} from './publicContract.js';

/** Canonical parsers for the Composer values accepted and returned by this Host API. */
export const ComposerDecorationResultV1Schema: PluginUiSchema<ComposerDecorationResultV1> =
    canonicalComposerDecorationResultV1Schema;
export const ComposerDecorationSetV1Schema: PluginUiSchema<ComposerDecorationSetV1> =
    canonicalComposerDecorationSetV1Schema;
export const ComposerFocusResultV1Schema: PluginUiSchema<ComposerFocusResultV1> =
    canonicalComposerFocusResultV1Schema;
export const ComposerInputLockRequestV1Schema: PluginUiSchema<ComposerInputLockRequestV1> =
    canonicalComposerInputLockRequestV1Schema;
export const ComposerOperationV1Schema: PluginUiSchema<ComposerOperationV1> =
    canonicalComposerOperationV1Schema;
export const ComposerReadResultV1Schema: PluginUiSchema<ComposerReadResultV1> =
    canonicalComposerReadResultV1Schema;
export const ComposerRefV1Schema: PluginUiSchema<ComposerRefV1> = canonicalComposerRefV1Schema;
export const ComposerSurfaceInputV1Schema: PluginUiSchema<ComposerSurfaceInputV1> =
    canonicalComposerSurfaceInputV1Schema;
export const ComposerSnapshotV1Schema: PluginUiSchema<ComposerSnapshotV1> = canonicalComposerSnapshotV1Schema;
export const ComposerTransactionResultV1Schema: PluginUiSchema<ComposerTransactionResultV1> =
    canonicalComposerTransactionResultV1Schema;
export const ComposerTransactionV1Schema: PluginUiSchema<ComposerTransactionV1> =
    canonicalComposerTransactionV1Schema;
export const ComposerContentHandleV1Schema: PluginUiSchema<ComposerContentHandleV1> =
    canonicalComposerContentHandleV1Schema;
export const ComposerContentInspectRequestV1Schema: PluginUiSchema<ComposerContentInspectRequestV1> =
    canonicalComposerContentInspectRequestV1Schema;
export const ComposerContentPickMediaRequestV1Schema: PluginUiSchema<ComposerContentPickMediaRequestV1> =
    canonicalComposerContentPickMediaRequestV1Schema;

/**
 * The bounded invalidation/retirement signal a resource subscription delivers
 * (§3.6). It is deliberately not a payload channel: `readResource` remains the
 * single snapshot authority, so an author re-reads after an `invalidated`
 * event.
 *
 * Dynamic Resource producers now own `invalidated` emission; this public type
 * describes their level-triggered signal without creating a second payload or
 * snapshot channel.
 */
export type ResourceSubscriptionEvent = PluginUiResourceSubscriptionEventV1;

/**
 * Public browser-safe projection of the canonical admitted-operation identity.
 * Its parameter is derived from the SDK-owned public snapshot instead of
 * exposing the Protocol declaration that implements the key. The value remains
 * the exact canonical function object; callers must not treat its result as an
 * authority token.
 */
export const pluginUiTargetedContributionOperationKey: (
    operation: PluginUiTargetedContributionOperationV1,
) => string = canonicalPluginUiTargetedContributionOperationKey;

/**
 * UI transport always carries JSON. A producer Action whose runtime result is
 * `void` therefore resolves as the honest transport value `null`.
 */
export type PluginUiActionTransportResult<TResult extends JsonValue | void> =
    TResult extends void ? null : TResult;

/** An action reference accepted by the one mounted UI host dispatcher. */
export type PluginUiActionReference = PluginReference;

/** The producer-derived input for one UI action reference. */
export type PluginUiActionInputFor<TAction extends PluginUiActionReference> =
    TAction extends PluginInvocableActionId
            ? PluginActionInputById[TAction]
            : JsonValue;

/** The JSON result observable through the mounted UI action transport. */
export type PluginUiActionResultFor<TAction extends PluginUiActionReference> =
    TAction extends PluginInvocableActionId
            ? PluginActionResultById[TAction]
            : JsonValue;

/**
 * The one exact thing a mounted surface is about (§3.2).
 *
 * An exact target carries no ambiguous optional identity, and exactness fails
 * closed: `{ kind: 'app' }` means the surface is genuinely mounted on an app
 * target. A placement that cannot supply the id its arm requires does not
 * degrade to another arm — the host withholds the surface and reports it
 * unavailable, so a broken session/project/browser mount can never be
 * read as an app mount. `agentId` and `origin` stay optional because each is a
 * genuinely absent fact in reachable cases, not a missing identity.
 *
 * Host-private account, machine, server and generation authority is never
 * exposed here; the host stamps it at effect boundaries.
 */
export type PluginSurfaceTarget = PluginUiHostApiSurfaceTargetV1;

/**
 * The semantic theme snapshot (§3.3) — versioned data, not a style-system
 * object or a component ABI.
 *
 * Every colour projects one canonical Happier theme token resolved through the
 * user's ACTIVE theme profile, so switching profile changes these values. No
 * `elevation` token is exported: a bare number cannot carry Happier's composite
 * shadow definition and no CSS custom property can carry a number as a shadow,
 * so depth stays owned by the components that need it.
 */
export type PluginUiThemeV1 = PluginUiHostApiSurfaceThemeV1;

/**
 * The host-stamped surface snapshot, including the current Account disclosure,
 * presentation facts, and one admitted targeted-contribution projection.
 *
 * The strict payload grammar is Protocol-owned so `context()` and
 * `watchContext()` cannot diverge from the browser transport decoder.
 */
export type SurfaceContext = PluginUiHostApiSurfaceContextV1;

export type ResourceContent = Readonly<{
    contentType: string;
    digest: string;
    bytes: Uint8Array;
}>;

/**
 * A host-created, mount-bound reference to a workspace file. It is opaque to
 * plugins: it is never a path, `PluginPath`, artifact id, editor buffer, or
 * storage key.
 */
export type OpenableContentRef = OpenableContentRefV1;

/** JSON-safe content returned by {@link PluginUiHostApi.readOpenableContent}. */
export type OpenableContentBody = OpenableContentBodyV1;

/**
 * A bounded snapshot request. Omitting `maxBytes` deliberately leaves the
 * canonical host owner to apply its current default ceiling.
 */
export type OpenableContentReadRequest = OpenableContentReadRequestInputV1;

/** Typed host-derived metadata for one exact openable-content reference. */
export type OpenableContentStatResult = OpenableContentStatResultV1;

/** Typed bounded snapshot result; it never carries a byte array or a path. */
export type OpenableContentReadResult = OpenableContentReadResultV1;

/** Exact closed Protocol request: targeted selection or the one no-invoke Session literal. */
export type SelectActionInputRequest = PluginUiSelectActionInputRequestV1;

/** Exact closed Protocol settlement: targeted submission, Session draft, or cancellation. */
export type SelectActionInputResult = PluginUiSelectActionInputResultV1;

/**
 * The exact target-scoped settlement an outer contributed Action may consume.
 * It is transient host-selection data, never part of the Action input payload.
 */
export type PluginUiActionExecutionOptions = PluginCancellationOptions & Readonly<{
    selectedActionInput?: PluginUiSelectedActionInputCarrierV1;
}>;

/**
 * Options for {@link PluginUiHostApi.openSurface}.
 *
 * `subPath` is how a plugin navigates INSIDE a full-page destination
 * (`appPage`). The host owns the route prefix and generates the path, so a
 * plugin names only the location under its own page root — never a host path,
 * and never another plugin's namespace. Opening a page with a new `subPath`
 * pushes a real host history entry, so the user's back/forward walks the
 * page's own navigation, and re-entering the page restores that location.
 *
 * It is ignored by destinations that are not pages: a right-sidebar tab has no
 * location under it. `''` and an absent value both mean the page root; `.`/`..`
 * segments and an over-long value are rejected as a typed error rather than
 * normalized into some other location.
 */
export type OpenSurfaceOptions = PluginCancellationOptions & Readonly<{
    subPath?: string;
    /**
     * Optional opaque instance identity for a same-plugin destination. The
     * Protocol request schema owns validation and the host owns any reuse or
     * presentation policy; callers never turn it into a route or namespace.
     */
    instanceKey?: string;
}>;

export interface PluginUiHostApi {
    version(): Readonly<{
        apiVersion: string;
        wireVersion: number;
        methods: readonly SurfaceHostMethod[];
    }>;
    context(options?: PluginCancellationOptions): Promise<SurfaceContext>;
    /**
     * Observe surface-context changes (§3.6).
     *
     * Establishment is **acknowledged-async**: the promise resolves only after
     * the host admits the subscription. An unsupported, denied, stale or
     * malformed establishment rejects with a typed error and never yields a
     * disposable, so a caller can never hold a handle to a subscription the host
     * did not accept. Disposal is idempotent and retires the host resource
     * exactly once, including when it lands after a late admission.
     */
    watchContext(
        listener: (context: SurfaceContext) => void,
        options?: PluginCancellationOptions,
    ): Promise<Disposable>;
    /**
     * Execute a host ActionSpec surfaced to plugins, or one of this plugin's own
     * contributed actions.
     *
     * Host ActionSpecs retain their generated types; contributed references use
     * the structural JSON transport contract. `NoInfer` makes the action
     * reference, never a broad input object, decide which branch applies.
     */
    executeAction<TAction extends PluginUiActionReference>(
        action: TAction,
        input: NoInfer<PluginUiActionInputFor<NoInfer<TAction>>>,
        options?: PluginUiActionExecutionOptions,
    ): Promise<PluginUiActionResultFor<NoInfer<TAction>>>;
    selectActionInput(
        request: SelectActionInputRequest,
        options?: PluginCancellationOptions,
    ): Promise<SelectActionInputResult>;
    readResource(resource: PluginReference, options?: PluginCancellationOptions): Promise<ResourceContent>;
    /**
     * Read host-derived metadata for the exact opaque workspace-file reference
     * bound to this selected viewer mount. No path-resolution or directory API
     * is available through this surface.
     */
    statOpenableContent(
        ref: OpenableContentRef,
        options?: PluginCancellationOptions,
    ): Promise<OpenableContentStatResult>;
    /**
     * Read one revision-bound, bounded snapshot for the exact opaque reference.
     * The host owns currentness, cancellation, revision checks, and byte limits;
     * this is read-only and deliberately has no write/editor counterpart.
     */
    readOpenableContent(
        request: OpenableContentReadRequest,
        options?: PluginCancellationOptions,
    ): Promise<OpenableContentReadResult>;
    /**
     * Select an exactly qualified destination, optionally with a bounded launch
     * argument and, for a full-page destination, a location under its page root.
     * A bare local id binds to the caller. A structured reference may name any
     * plugin; the host's Surface Registry owns destination admission, scope
     * compatibility, cancellation, and the resulting navigation. The caller is
     * attributed to that host decision but cannot supply a local router or a
     * fallback target.
     */
    openSurface(view: PluginReference, input?: JsonValue, options?: OpenSurfaceOptions): Promise<void>;
    /**
     * Replace THIS full-page surface's own location without adding a history
     * entry, and declare the one page-internal step system Back returns to.
     *
     * This is the interaction counterpart of {@link PluginUiHostApi.openSurface}:
     * an open selects a destination and pushes, which is right for "take me
     * somewhere" and wrong for "what I am already looking at is now filtered,
     * ordered or selected differently". A page that pushed on every such change
     * would bury the user's real previous screen under its own interaction
     * trail, and Back would walk that trail instead of leaving.
     *
     * `backLocation` is the page's Back participant, expressed as a location
     * rather than a callback: a callback cannot be answered synchronously
     * across the host boundary, and a Back whose outcome waits on a round trip
     * is the kind of bug a user cannot describe. The host consumes at most ONE
     * Back with it and then yields, so the next press performs ordinary
     * navigation. A declared location equal to the location being replaced to
     * is inert rather than a Back that visibly does nothing. It is retired with
     * this mount and by any navigation the page did not perform itself.
     *
     * Resolves with the location the host settled on, which the caller renders.
     * It is not necessarily the requested one. Only a full-page destination has
     * a location; elsewhere the host does not advertise this method.
     */
    replacePageLocation(
        subPath: string,
        options?: PluginCancellationOptions & Readonly<{ backLocation?: string }>,
    ): Promise<Readonly<{ subPath: string }>>;
    /**
     * Ordinary plugin-local feedback, delegated to Happier's own presentation
     * owner (§3.4). It is not an approval bypass and does not change ActionSpec
     * present-user policy; an action's intrinsic confirmation stays with the
     * Action executor.
     */
    notify(
        message: string,
        options?: Readonly<{ severity?: InteractionSeverity; signal?: AbortSignal }>,
    ): Promise<void>;
    /**
     * Ordinary plugin-local confirmation, delegated to Happier's own interaction
     * owner (§3.4). Declining resolves `false`; it never throws to express the
     * user's answer.
     *
     * Withdrawing the question through `signal` is not an answer: the dialog is
     * dismissed, a late answer to it is inert, and the call rejects with a typed
     * host error rather than resolving `false` — a decline the user never made.
     */
    confirm(
        message: string,
        options?: Readonly<{ title?: string; signal?: AbortSignal }>,
    ): Promise<boolean>;
    /**
     * Observe a resource for invalidation (§3.6). Same acknowledged-async
     * establishment contract as {@link PluginUiHostApi.watchContext}.
     *
     * The event is a bounded invalidation SIGNAL, never a payload channel:
     * `readResource` remains the single snapshot authority, so an observer
     * re-reads after an `invalidated` event rather than receiving bytes here.
     *
     * A **packaged** resource is immutable within its generation, so a host
     * serving only packaged resources never advertises this method and calling
     * it rejects with `unsupported_method`. A **dynamic** resource is backed by
     * the plugin's registered producer and is genuinely watchable.
     */
    watchResource(
        resource: PluginReference,
        listener: (event: ResourceSubscriptionEvent) => void,
        options?: PluginCancellationOptions,
    ): Promise<Disposable>;
    /**
     * Resolve the host's currently focused Composer reference, if this mount
     * can truthfully address one. Ordinary absence is `null`, not an error.
     */
    activeComposer(options?: PluginCancellationOptions): Promise<ComposerRefV1 | null>;
    /** Read one exact Composer scope through the canonical document owner. */
    readComposer(
        ref: ComposerRefV1,
        options?: PluginCancellationOptions,
    ): Promise<ComposerReadResultV1>;
    /**
     * Observe one exact Composer scope. Establishment and disposal use the
     * same acknowledged-async host resource lifecycle as other subscriptions.
     */
    watchComposer(
        ref: ComposerRefV1,
        listener: (snapshot: ComposerSnapshotV1) => void,
        options?: PluginCancellationOptions,
    ): Promise<Disposable>;
    /** Apply one revision-checked Composer transaction atomically. */
    applyComposer(
        ref: ComposerRefV1,
        transaction: ComposerTransactionV1,
        options?: PluginCancellationOptions,
    ): Promise<ComposerTransactionResultV1>;
    /** Request focus for one exact Composer scope. */
    focusComposer(
        ref: ComposerRefV1,
        options?: PluginCancellationOptions,
    ): Promise<ComposerFocusResultV1>;
    /** Set or clear this caller's keyed revision-bound decoration set. */
    setComposerDecorations(
        ref: ComposerRefV1,
        key: string,
        decorations: ComposerDecorationSetV1 | null,
        options?: PluginCancellationOptions,
    ): Promise<ComposerDecorationResultV1>;
    /**
     * Acquire one scoped input-lock lease. The returned disposable is the sole
     * release capability; locks never become a second mutation authority.
     */
    acquireComposerInputLock(
        ref: ComposerRefV1,
        request: ComposerInputLockRequestV1,
        options?: PluginCancellationOptions,
    ): Promise<Disposable>;
    /** Pick and stage media under the host-bound target; caller-supplied paths and bytes are never accepted. */
    pickComposerMedia(
        ref: ComposerRefV1,
        request: ComposerContentPickMediaRequestV1,
        options?: PluginCancellationOptions,
    ): Promise<ComposerContentHandleV1>;
    /** Read one bounded inspection result; stage and transfer identities stay host-private. */
    inspectComposerContent(
        handle: ComposerContentHandleV1,
        request: ComposerContentInspectRequestV1,
        options?: PluginCancellationOptions,
    ): Promise<ComposerContentInspectResultV1>;
    /** Explicitly release an unattached staged-media claim. */
    releaseComposerContent(
        handle: ComposerContentHandleV1,
        options?: PluginCancellationOptions,
    ): Promise<void>;
    diagnostic(data: PluginDiagnosticData): void;
    readClipboard(options?: PluginCancellationOptions): Promise<string>;
    writeClipboard(value: string, options?: PluginCancellationOptions): Promise<void>;
    openExternalLink(url: string, options?: PluginCancellationOptions): Promise<void>;
}

export type PluginUiHostApiVersion = ReturnType<PluginUiHostApi['version']>;
/**
 * The advertisable method vocabulary is the intersection of the published
 * interface and Protocol's one initial tuple. The exact SDK-interface ↔
 * Protocol closure remains load-bearing in `clientTransport.ts`.
 */
export type SurfaceHostMethod = Extract<
    Exclude<keyof PluginUiHostApi, 'version'>,
    PluginUiHostMethodV1
>;

export interface RenderContext {
    readonly plugin: Readonly<{ id: string; version: string }>;
    readonly surface: SurfaceContext;
    readonly hostApi: PluginUiHostApi;
    readonly signal: AbortSignal;
    /**
     * The bounded, immutable input the opener passed to
     * `hostApi.openSurface(view, input)` when this surface was selected.
     *
     * It is `undefined` when the surface was opened without input — the host
     * never substitutes a default — and it is replaced, not merged, when an
     * already-selected surface is reopened with new input.
     */
    readonly launchInput?: JsonValue;
    /**
     * The plugin-local location inside a full-page destination (`appPage`) —
     * the remainder of the host-generated route after the page root, `''` at the
     * root itself.
     *
     * The host routes a page at `/plugins/<pluginId>/<localId>/*` and hands the
     * surface only this remainder, so a deep link to
     * `/plugins/notes/notes/work/ideas.md` renders with
     * `subPath: 'work/ideas.md'`. It is canonical: no leading, trailing or
     * repeated separators, so the same location is always the same string.
     *
     * `undefined` on every placement that is not a page — a right-sidebar tab
     * has no location under it, and the host never fabricates one.
     */
    readonly subPath?: string;
}

export type RenderSurface = (
    context: RenderContext,
) => Readonly<{ type: unknown; props: unknown; key: string | null }> | null;
