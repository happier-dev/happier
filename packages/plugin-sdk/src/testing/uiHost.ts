/** @moduleRealm daemon */
import { z } from 'zod';

import {
    PLUGIN_UI_HOST_API_VERSION_V1,
    isPluginUiHostApiVersionCompatibleV1,
    PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
    PLUGIN_UI_HOST_METHODS_V1,
    PluginUiArtifactDigestV1Schema,
    PluginUiAcquireComposerInputLockRequestV1Schema,
    PluginUiActiveComposerResultV1Schema,
    PluginUiApplyComposerRequestV1Schema,
    PluginUiApplyComposerResultV1Schema,
    PluginUiInspectComposerContentRequestV1Schema,
    PluginUiInspectComposerContentResultV1Schema,
    PluginUiExecuteActionRequestV1Schema,
    PluginUiFocusComposerRequestV1Schema,
    PluginUiFocusComposerResultV1Schema,
    PluginUiHostApiDiagnosticV1Schema,
    PluginUiHostApiOpenExternalLinkRequestV1Schema,
    PluginUiHostApiWriteClipboardRequestV1Schema,
    PluginUiHostApiWireEnvelopeV1Schema,
    PluginUiHostApiWireIdentityV1Schema,
    PluginUiJsonValueV1Schema,
    PluginUiOpenSurfaceRequestV1Schema,
    PluginUiReplacePageLocationRequestV1Schema,
    PluginUiPickComposerMediaRequestV1Schema,
    PluginUiPickComposerMediaResultV1Schema,
    PluginUiPublishCurrentUiContextRequestV1Schema,
    PluginUiReadComposerRequestV1Schema,
    PluginUiReadComposerResultV1Schema,
    PluginUiReleaseComposerContentRequestV1Schema,
    PluginUiSelectActionInputRequestV1Schema,
    PluginUiSelectActionInputResultV1Schema,
    PluginUiSetComposerDecorationsRequestV1Schema,
    PluginUiSetComposerDecorationsResultV1Schema,
    PluginUiInstanceKeyV1Schema,
    PluginUiLaunchInputV1Schema,
    PluginUiResourceSubscriptionTargetV1Schema,
    PluginUiSelectedActionInputCarrierV1Schema,
    PluginUiSubPathV1Schema,
    PluginUiWatchComposerRequestV1Schema,
    type PluginUiHostApiWireEnvelopeV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    DaemonPluginUiTargetedSurfaceMountsV1Schema,
    DaemonPluginUiTargetedSurfaceRendererAvailabilityV1Schema,
    OpenableContentReadRequestV1Schema,
    OpenableContentRefV1Schema,
    readDaemonPluginUiTargetedSurfaceMountV1,
} from '@happier-dev/protocol';
import {
    derivePluginUiTargetedSurfaceMountInstanceKeyV1,
    PluginUiTargetedContributionSurfaceV1Schema,
} from '@happier-dev/protocol/plugins/ui/targetedContributions';
import { composerRefsV1Equal } from '@happier-dev/protocol/plugins/ui/composerRef';

import type { PluginDiagnosticData } from '../diagnostics.js';
import { isPluginError, PluginError } from '../errors.js';
import type { JsonValue, PluginReference } from '../identity.js';
import type { InteractionSeverity } from '../interactions.js';
import type { Disposable } from '../lifecycle.js';
import {
    compilePluginJsonSchema,
    isValidPluginJsonSchemaValue,
    parsePluginManifest,
} from '../manifest.js';
import { PluginUiHostApiClientError, createPluginUiHostApiClientFromTransport } from '../ui/clientTransport.js';
import type {
    OpenableContentReadResult,
    OpenableContentReadRequest,
    OpenableContentRef,
    OpenableContentStatResult,
    ComposerDecorationResultV1,
    ComposerDecorationSetV1,
    ComposerContentHandleV1,
    ComposerContentInspectRequestV1,
    ComposerContentInspectResultV1,
    ComposerContentPickMediaRequestV1,
    ComposerFocusResultV1,
    ComposerInputLockRequestV1,
    ComposerReadResultV1,
    ComposerRefV1,
    ComposerSnapshotV1,
    ComposerTransactionResultV1,
    ComposerTransactionV1,
    PluginUiContextEnrichmentV1,
    RenderContext,
    ResourceContent,
    SurfaceContext,
    SelectActionInputRequest,
    SelectActionInputResult,
} from '../ui/hostApi.js';
import {
    ComposerRefV1Schema,
    ComposerSnapshotV1Schema,
} from '../ui/hostApi.js';
import type {
    PluginUiHostApiWireIdentityV1,
    PluginUiSchema,
    PluginUiSelectedActionInputCarrierV1,
    PluginUiTestkitMountAvailability,
} from '../ui/publicContract.js';

export type {
    PluginUiHostApiWireIdentityV1,
    PluginUiTestkitMountAvailability,
} from '../ui/publicContract.js';

const PLUGIN_UI_SEMANTIC_ROLES = [
    'alert',
    'button',
    'checkbox',
    'form',
    'group',
    'heading',
    'image',
    'link',
    'list',
    'listitem',
    'option',
    'progressbar',
    'radio',
    'radiogroup',
    'separator',
    'status',
    'switch',
    'tab',
    'tablist',
    'tabpanel',
    'textbox',
    'toolbar',
] as const;

/** The bounded semantic role vocabulary a UI fixture can observe. */
export type PluginUiSemanticRole = typeof PLUGIN_UI_SEMANTIC_ROLES[number];
const pluginUiSemanticRoleSchema = z.enum(PLUGIN_UI_SEMANTIC_ROLES);
export const PluginUiSemanticRoleSchema: PluginUiSchema<PluginUiSemanticRole> = pluginUiSemanticRoleSchema;

/** The bounded observable state a UI fixture can query. */
export type PluginUiSemanticState = Readonly<{
    disabled?: boolean;
    busy?: boolean;
    selected?: boolean;
    checked?: boolean | 'mixed';
    expanded?: boolean;
}>;
const pluginUiSemanticStateSchema = z.object({
    disabled: z.boolean().optional(),
    busy: z.boolean().optional(),
    selected: z.boolean().optional(),
    checked: z.union([z.boolean(), z.literal('mixed')]).optional(),
    expanded: z.boolean().optional(),
}).strict();
export const PluginUiSemanticStateSchema: PluginUiSchema<PluginUiSemanticState> = pluginUiSemanticStateSchema;

/** A framework-neutral semantic target returned by a fixture query. */
const pluginUiSemanticTargetSchema = z.object({
    role: pluginUiSemanticRoleSchema,
    name: z.string().trim().min(1).optional(),
    state: pluginUiSemanticStateSchema.optional(),
    /** The accessible label of a real implicit text field. */
    label: z.string().trim().min(1).optional(),
    /** The placeholder exposed by a real implicit text field. */
    placeholder: z.string().trim().min(1).optional(),
    /** The exact current value exposed by a real implicit text field. */
    value: z.string().optional(),
}).strict();
export type PluginUiSemanticTarget = Readonly<{
    role: PluginUiSemanticRole;
    name?: string;
    state?: PluginUiSemanticState;
    label?: string;
    placeholder?: string;
    value?: string;
}>;
export const PluginUiSemanticTargetSchema: PluginUiSchema<PluginUiSemanticTarget> = pluginUiSemanticTargetSchema;

/** Query refinements for one bounded semantic role. */
export type PluginUiSemanticQueryOptions = Readonly<{
    name?: string;
    state?: PluginUiSemanticState;
    label?: string;
    placeholder?: string;
    value?: string;
}>;

/** A framework-neutral textual fact returned by `getByText` / `queryByText`. */
const pluginUiSemanticTextTargetSchema = z.object({
    content: z.string().trim().min(1),
}).strict();
export type PluginUiSemanticTextTarget = Readonly<{ content: string }>;
export const PluginUiSemanticTextTargetSchema: PluginUiSchema<PluginUiSemanticTextTarget> =
    pluginUiSemanticTextTargetSchema;

/**
 * The framework-adapter ingress projection. It is deliberately not the query
 * result: `handle` and `revision` stay inside the SDK fixture so authors can
 * neither construct targets nor make currentness decisions themselves.
 */
export type PluginUiSemanticAdapterNode = Readonly<{
    handle: string;
    role: PluginUiSemanticRole;
    name?: string;
    state?: PluginUiSemanticState;
    label?: string;
    placeholder?: string;
    value?: string;
    actions?: readonly 'press'[];
}>;

/** A text-content projection with no invented ARIA role. */
export type PluginUiSemanticAdapterText = Readonly<{ content: string }>;

export type PluginUiSemanticAdapterSnapshot = Readonly<{
    revision: number;
    nodes: readonly PluginUiSemanticAdapterNode[];
    texts?: readonly PluginUiSemanticAdapterText[];
}>;

const PluginUiSemanticAdapterNodeSchema = z.object({
    handle: z.string().trim().min(1),
    role: pluginUiSemanticRoleSchema,
    name: z.string().trim().min(1).optional(),
    state: pluginUiSemanticStateSchema.optional(),
    label: z.string().trim().min(1).optional(),
    placeholder: z.string().trim().min(1).optional(),
    value: z.string().optional(),
    actions: z.array(z.literal('press')).optional(),
}).strict();

const PluginUiSemanticAdapterTextSchema = z.object({
    content: z.string().trim().min(1),
}).strict();

/** Strict framework-adapter ingress schema; never returned by the fixture. */
const pluginUiSemanticAdapterSnapshotSchema = z.object({
    revision: z.number().int().nonnegative(),
    nodes: z.array(PluginUiSemanticAdapterNodeSchema),
    texts: z.array(PluginUiSemanticAdapterTextSchema).optional(),
}).strict();
export const PluginUiSemanticAdapterSnapshotSchema: PluginUiSchema<PluginUiSemanticAdapterSnapshot> =
    pluginUiSemanticAdapterSnapshotSchema;

/**
 * The framework-owned mount contract. Plugin UI's RNW implementation is the
 * sole current adapter producer; it mounts the real author surface and
 * projects only observable role/name/state facts to the fixture.
 */
export interface PluginUiSemanticSurfaceMount {
    snapshot(): Promise<PluginUiSemanticAdapterSnapshot>;
    update(context: RenderContext): Promise<void>;
    invoke(input: Readonly<{
        revision: number;
        handle: string;
        action: 'press';
        /** Re-read by the adapter immediately before invocation. */
        target: PluginUiSemanticTarget;
    }>): Promise<void>;
    dispose(): Promise<void>;
}

export interface PluginUiSemanticSurfaceAdapter<TSurface> {
    mount(input: Readonly<{
        surface: TSurface;
        context: RenderContext;
        signal: AbortSignal;
    }>): Promise<PluginUiSemanticSurfaceMount>;
}

/**
 * The bounded test-facing view of one host-admitted targeted Surface mount.
 *
 * It is projected only after the exact daemon cold-admission schema, target,
 * contributor generation, selected renderer, and role input all agree. Host
 * renderer declarations, execution origin, Resource capability, artifacts,
 * and currentness machinery remain private to the parsed admission fact.
 */
export type PluginUiTestkitTargetedSurfaceAdmission = Readonly<{
    key: string;
    target: Readonly<{
        pluginId: string;
        immutableGenerationId: string;
    }>;
    contributor: Readonly<{
        pluginId: string;
        contributionId: string;
        immutableGenerationId: string;
    }>;
    point: Readonly<{
        pointId: string;
        protocol: Readonly<{ id: string; version: number }>;
    }>;
    role: string;
    presentation: 'content' | 'fill';
    content: Readonly<{
        kind: 'declarativeText';
        text: string;
    }>;
    input: JsonValue;
    instanceKey: string;
}>;

/**
 * Consume the same strict cold semantic admission projection as the real UI
 * host and return only the facts a semantic RN/RNW test adapter may render.
 * Raw structural PluginTestkit snapshots are intentionally not accepted.
 */
export function readPluginUiTestkitTargetedSurfaceAdmission(input: Readonly<{
    mounts: unknown;
    target: Readonly<{ pluginId: string; immutableGenerationId: string }>;
    surface: unknown;
    launchInput: unknown;
    /** The actual public manifest exported by the admitted contributor package. */
    contributorManifest: unknown;
    instanceKey?: unknown;
}>): PluginUiTestkitTargetedSurfaceAdmission | null {
    const mounts = DaemonPluginUiTargetedSurfaceMountsV1Schema.safeParse(input.mounts);
    const surface = PluginUiTargetedContributionSurfaceV1Schema.safeParse(input.surface);
    const launchInput = PluginUiLaunchInputV1Schema.safeParse(input.launchInput);
    const rawInstanceKey = input.instanceKey === undefined
        ? undefined
        : PluginUiInstanceKeyV1Schema.safeParse(input.instanceKey);
    if (
        !mounts.success
        || !surface.success
        || !launchInput.success
        || (rawInstanceKey !== undefined && !rawInstanceKey.success)
    ) {
        return null;
    }
    const mount = readDaemonPluginUiTargetedSurfaceMountV1({
        mounts: mounts.data,
        target: input.target,
        surface: surface.data,
    });
    if (!mount) return null;
    if (mount.selectedRenderer.availability.state !== 'available') return null;
    if (mount.selectedRenderer.renderer.kind !== 'declarative') return null;
    const contributorManifest = parsePluginManifest(input.contributorManifest);
    if (
        !contributorManifest.ok
        || contributorManifest.manifest.id !== mount.contributor.pluginId
    ) return null;
    const rendererId = mount.selectedRenderer.identity.localId;
    const renderers = contributorManifest.manifest.contributes.ui.renderers ?? [];
    const matchingRenderers = renderers.filter((renderer) => renderer.id === rendererId);
    if (matchingRenderers.length !== 1) return null;
    const declaredRenderer = matchingRenderers[0]!;
    if (declaredRenderer.kind !== 'declarative') return null;
    const root = Reflect.get(declaredRenderer, 'root') as unknown;
    if (
        root === null
        || typeof root !== 'object'
        || Array.isArray(root)
        || Reflect.get(root, 'kind') !== 'text'
        || typeof Reflect.get(root, 'text') !== 'string'
    ) return null;
    const content = Object.freeze({
        kind: 'declarativeText' as const,
        text: Reflect.get(root, 'text') as string,
    });
    let validatesInput = false;
    try {
        const validator = compilePluginJsonSchema(mount.inputSchema);
        validatesInput = isValidPluginJsonSchemaValue(validator, launchInput.data);
    } catch {
        return null;
    }
    if (!validatesInput) return null;

    const instanceKey = derivePluginUiTargetedSurfaceMountInstanceKeyV1({
        targetPluginId: mount.target.pluginId,
        surface: surface.data,
        ...(rawInstanceKey?.success ? { rawInstanceKey: rawInstanceKey.data } : {}),
    });
    const target = Object.freeze({
        pluginId: mount.target.pluginId,
        immutableGenerationId: mount.target.immutableGenerationId,
    });
    const contributor = Object.freeze({
        pluginId: mount.contributor.pluginId,
        contributionId: mount.contributor.contributionId,
        immutableGenerationId: mount.contributor.immutableGenerationId,
    });
    const point = Object.freeze({
        pointId: mount.point.pointId,
        protocol: Object.freeze({
            id: mount.point.protocol.id,
            version: mount.point.protocol.version,
        }),
    });
    return Object.freeze({
        // The Protocol instance key is intentionally generation-stable. The
        // semantic adapter key adds both lifecycle fences so React retires an
        // old physical child instead of updating it across replacement.
        key: JSON.stringify([
            mount.target.immutableGenerationId,
            mount.contributor.immutableGenerationId,
            instanceKey,
        ]),
        target,
        contributor,
        point,
        role: mount.role,
        presentation: mount.presentation,
        content,
        input: launchInput.data,
        instanceKey,
    });
}

export type PluginUiTestkitExecuteActionInput = Readonly<{
    action: PluginReference;
    input: JsonValue;
    /**
     * The exact transient selected-input settlement carried by an outer Action.
     * It remains separate from the JSON Action input just as it does in the
     * mounted host protocol.
     */
    selectedActionInput?: PluginUiSelectedActionInputCarrierV1;
    /**
     * Test-only observation of the mounted host-private terminal execution
     * fact. It is never exposed through the plugin author Host API surface.
     */
    consumeSelectedActionInput?: true;
    signal: AbortSignal;
}>;

export type PluginUiTestkitReadResourceInput = Readonly<{
    resource: PluginReference;
    signal: AbortSignal;
}>;

/** One opaque host-selected reference; the fixture has no path or mount resolver. */
export type PluginUiTestkitStatOpenableContentInput = Readonly<{
    ref: OpenableContentRef;
    signal: AbortSignal;
}>;

/** One revision-bound, bounded request parsed by the canonical Protocol owner. */
export type PluginUiTestkitReadOpenableContentInput = Readonly<{
    request: OpenableContentReadRequest & Readonly<{ maxBytes: number }>;
    signal: AbortSignal;
}>;

export type PluginUiTestkitWatchResourceInput = Readonly<{
    resource: PluginReference;
    signal: AbortSignal;
}>;

/** A factual active-Composer lookup for this fixture mount. */
export type PluginUiTestkitActiveComposerInput = Readonly<{
    signal: AbortSignal;
}>;

/** One host-selected composer scope, never inferred from a fixture target. */
export type PluginUiTestkitReadComposerInput = Readonly<{
    ref: ComposerRefV1;
    signal: AbortSignal;
}>;

/** One semantic Composer mutation routed through the canonical document owner. */
export type PluginUiTestkitApplyComposerInput = Readonly<{
    ref: ComposerRefV1;
    transaction: ComposerTransactionV1;
    signal: AbortSignal;
}>;

/** One revision-bound Composer decoration update. */
export type PluginUiTestkitSetComposerDecorationsInput = Readonly<{
    ref: ComposerRefV1;
    key: string;
    decorations: ComposerDecorationSetV1 | null;
    signal: AbortSignal;
}>;

/** One Composer input-lock lease establishment. Its returned disposable owns release. */
export type PluginUiTestkitAcquireComposerInputLockInput = Readonly<{
    ref: ComposerRefV1;
    request: ComposerInputLockRequestV1;
    signal: AbortSignal;
}>;

/** One host-bound media selection; the fixture never receives a source path or raw file bytes. */
export type PluginUiTestkitPickComposerMediaInput = Readonly<{
    ref: ComposerRefV1;
    request: ComposerContentPickMediaRequestV1;
    signal: AbortSignal;
}>;

/** One bounded inspection of an opaque staged-media claim. */
export type PluginUiTestkitInspectComposerContentInput = Readonly<{
    handle: ComposerContentHandleV1;
    request: ComposerContentInspectRequestV1;
    signal: AbortSignal;
}>;

/** Explicit release of an opaque staged-media claim. */
export type PluginUiTestkitReleaseComposerContentInput = Readonly<{
    handle: ComposerContentHandleV1;
    signal: AbortSignal;
}>;

export type PluginUiTestkitOpenSurfaceInput = Readonly<{
    view: PluginReference;
    input?: JsonValue;
    subPath?: string;
    instanceKey?: string;
    signal: AbortSignal;
}>;

/**
 * One same-page location replacement, with the page-internal Back step it
 * declared. A fixture host answers with the location it settled on, which is
 * how a surface under test observes a host that redirected or clamped it.
 */
export type PluginUiTestkitReplacePageLocationInput = Readonly<{
    subPath: string;
    backLocation?: string;
    signal: AbortSignal;
}>;

export type PluginUiTestkitSelectActionInputInput = Readonly<{
    request: SelectActionInputRequest;
    signal: AbortSignal;
}>;

export type PluginUiTestkitHostHandlers = Readonly<{
    publishCurrentUiContext?: (
        input: Readonly<{ enrichment: PluginUiContextEnrichmentV1 | null; signal: AbortSignal }>,
    ) => void | Promise<void>;
    executeAction?: (input: PluginUiTestkitExecuteActionInput) => JsonValue | Promise<JsonValue>;
    selectActionInput?: (
        input: PluginUiTestkitSelectActionInputInput,
    ) => SelectActionInputResult | Promise<SelectActionInputResult>;
    readResource?: (input: PluginUiTestkitReadResourceInput) => ResourceContent | Promise<ResourceContent>;
    statOpenableContent?: (
        input: PluginUiTestkitStatOpenableContentInput,
    ) => OpenableContentStatResult | Promise<OpenableContentStatResult>;
    readOpenableContent?: (
        input: PluginUiTestkitReadOpenableContentInput,
    ) => OpenableContentReadResult | Promise<OpenableContentReadResult>;
    /**
     * Establish a factual dynamic-resource watch and return the canonical
     * post-establishment digest. The fixture supplies its generated
     * subscription identity, then emits the same `{ subscriptionId, digest }`
     * acknowledgement that a current host returns.
     */
    watchResource?: (
        input: PluginUiTestkitWatchResourceInput,
    ) => Readonly<{ digest: string }> | Promise<Readonly<{ digest: string }>>;
    /** Presence truthfully advertises a focused Composer lookup for this fixture mount. */
    activeComposer?: (input: PluginUiTestkitActiveComposerInput) => ComposerRefV1 | null | Promise<ComposerRefV1 | null>;
    readComposer?: (input: PluginUiTestkitReadComposerInput) => ComposerReadResultV1 | Promise<ComposerReadResultV1>;
    /**
     * Establish one Composer observation; event production remains host-owned.
     * An optional returned disposer observes this exact resource's disposal,
     * cancellation, and fixture retirement.
     */
    watchComposer?: (
        input: PluginUiTestkitReadComposerInput,
    ) => void | Disposable | Promise<void | Disposable>;
    applyComposer?: (input: PluginUiTestkitApplyComposerInput) => ComposerTransactionResultV1 | Promise<ComposerTransactionResultV1>;
    focusComposer?: (input: PluginUiTestkitReadComposerInput) => ComposerFocusResultV1 | Promise<ComposerFocusResultV1>;
    setComposerDecorations?: (
        input: PluginUiTestkitSetComposerDecorationsInput,
    ) => ComposerDecorationResultV1 | Promise<ComposerDecorationResultV1>;
    /**
     * Establish one input-lock lease through the shared subscription lifecycle.
     * Its optional disposer observes the same resource retirement boundary.
     */
    acquireComposerInputLock?: (
        input: PluginUiTestkitAcquireComposerInputLockInput,
    ) => void | Disposable | Promise<void | Disposable>;
    pickComposerMedia?: (
        input: PluginUiTestkitPickComposerMediaInput,
    ) => ComposerContentHandleV1 | Promise<ComposerContentHandleV1>;
    inspectComposerContent?: (
        input: PluginUiTestkitInspectComposerContentInput,
    ) => ComposerContentInspectResultV1 | Promise<ComposerContentInspectResultV1>;
    releaseComposerContent?: (
        input: PluginUiTestkitReleaseComposerContentInput,
    ) => void | Promise<void>;
    openSurface?: (input: PluginUiTestkitOpenSurfaceInput) => void | Promise<void>;
    replacePageLocation?: (
        input: PluginUiTestkitReplacePageLocationInput,
    ) => string | Promise<string>;
    notify?: (input: Readonly<{ message: string; severity?: InteractionSeverity; signal: AbortSignal }>) => void | Promise<void>;
    confirm?: (input: Readonly<{ message: string; title?: string; signal: AbortSignal }>) => boolean | Promise<boolean>;
    diagnostic?: (input: Readonly<{ data: PluginDiagnosticData; signal: AbortSignal }>) => void | Promise<void>;
    readClipboard?: (input: Readonly<{ signal: AbortSignal }>) => string | Promise<string>;
    writeClipboard?: (input: Readonly<{ value: string; signal: AbortSignal }>) => void | Promise<void>;
    openExternalLink?: (input: Readonly<{ url: string; signal: AbortSignal }>) => void | Promise<void>;
}>;

type PluginUiTestkitHostMethodPolicy = 'fixture' | keyof PluginUiTestkitHostHandlers;

/**
 * The fixture's one explicit policy for every canonical Host API method.
 * `fixture` methods have no supplied boundary handler; all other methods are
 * advertised only when their named host-boundary handler is installed.
 */
const hostMethodPolicies = {
    context: 'fixture',
    publishCurrentUiContext: 'publishCurrentUiContext',
    watchContext: 'fixture',
    executeAction: 'executeAction',
    readResource: 'readResource',
    statOpenableContent: 'statOpenableContent',
    readOpenableContent: 'readOpenableContent',
    watchResource: 'watchResource',
    openSurface: 'openSurface',
    replacePageLocation: 'replacePageLocation',
    notify: 'notify',
    confirm: 'confirm',
    diagnostic: 'diagnostic',
    readClipboard: 'readClipboard',
    writeClipboard: 'writeClipboard',
    openExternalLink: 'openExternalLink',
    selectActionInput: 'selectActionInput',
    activeComposer: 'activeComposer',
    readComposer: 'readComposer',
    watchComposer: 'watchComposer',
    applyComposer: 'applyComposer',
    focusComposer: 'focusComposer',
    setComposerDecorations: 'setComposerDecorations',
    acquireComposerInputLock: 'acquireComposerInputLock',
    pickComposerMedia: 'pickComposerMedia',
    inspectComposerContent: 'inspectComposerContent',
    releaseComposerContent: 'releaseComposerContent',
} as const satisfies Readonly<Record<(typeof PLUGIN_UI_HOST_METHODS_V1)[number], PluginUiTestkitHostMethodPolicy>>;

function isHostMethodAvailable(
    method: (typeof PLUGIN_UI_HOST_METHODS_V1)[number],
    handlers: PluginUiTestkitHostHandlers,
): boolean {
    const policy = hostMethodPolicies[method];
    return policy === 'fixture' || handlers[policy] !== undefined;
}

/**
 * The exact already-derived host availability tuple a UI fixture may consume.
 *
 * The fixture only parses and presents this canonical boundary fact. It never
 * evaluates destination, platform, policy, renderer, or hosted-web admission.
 */
export type PluginUiTestkitMountInput = Readonly<{
    availability: PluginUiTestkitMountAvailability;
}>;

export type PluginUiTestkitMountResult =
    | Readonly<{ kind: 'mounted'; fixture: PluginUiTestkit }>
    | Readonly<{ kind: 'refused'; availability: PluginUiTestkitMountAvailability }>;

/** Mount the supplied surface without an external host admission fact. */
export type PluginUiTestkitOptions<TSurface> = Readonly<{
    identity: PluginUiHostApiWireIdentityV1;
    surface: TSurface;
    /** The host-owned context snapshot; its strict decoding is performed by the real public client. */
    surfaceContext: SurfaceContext;
    adapter: PluginUiSemanticSurfaceAdapter<TSurface>;
    /** Optional client compatibility request for transport-contract tests. */
    apiRange?: string;
    launchInput?: JsonValue;
    subPath?: string;
    handlers?: PluginUiTestkitHostHandlers;
    mount?: undefined;
}>;

/** Consume one canonical host availability fact before the adapter can mount. */
export type PluginUiTestkitMountOptions<TSurface> = Omit<
    PluginUiTestkitOptions<TSurface>,
    'mount'
> & Readonly<{
    mount: PluginUiTestkitMountInput;
}>;

export interface PluginUiTestkit {
    /** The exact public mount context supplied to the author surface. */
    readonly context: RenderContext;
    /** Push one new host-owned context through the semantic mount and `watchContext`. */
    updateSurface(surface: SurfaceContext): Promise<void>;
    /**
     * Settle one new plugin-local page location and re-render the surface with
     * it, exactly as the host's own page-location owner does.
     *
     * This is the host half of a full-page surface's location contract: the
     * page asks through `replacePageLocation` and the host answers by making a
     * location current, but the host also makes one current for navigation the
     * page never performed — system Back walking a declared step, a deep link,
     * or ordinary history movement. A test plays the host here, so it can
     * exercise both directions rather than only the location a mount opened at.
     */
    updatePageLocation(subPath: string): Promise<void>;
    /** Emit only the canonical invalidation signal; consumers re-read through `hostApi.readResource`. */
    invalidateResource(resource: PluginReference, digest: string): void;
    /** Emit one schema-checked observation through exact active Composer watches. */
    emitComposerSnapshot(ref: ComposerRefV1, snapshot: ComposerSnapshotV1): void;
    getByRole(role: PluginUiSemanticRole, options?: PluginUiSemanticQueryOptions): Promise<PluginUiSemanticTarget>;
    queryByRole(role: PluginUiSemanticRole, options?: PluginUiSemanticQueryOptions): Promise<PluginUiSemanticTarget | undefined>;
    getAllByRole(role: PluginUiSemanticRole, options?: PluginUiSemanticQueryOptions): Promise<readonly PluginUiSemanticTarget[]>;
    queryAllByRole(role: PluginUiSemanticRole, options?: PluginUiSemanticQueryOptions): Promise<readonly PluginUiSemanticTarget[]>;
    /** Wait briefly for exactly one semantic target without exposing renderer scheduling. */
    findByRole(role: PluginUiSemanticRole, options?: PluginUiSemanticQueryOptions): Promise<PluginUiSemanticTarget>;
    getByText(content: string): Promise<PluginUiSemanticTextTarget>;
    queryByText(content: string): Promise<PluginUiSemanticTextTarget | undefined>;
    /** The sole initial semantic action. */
    press(target: PluginUiSemanticTarget): Promise<void>;
    /** Retire this generation and abort all author and boundary work. */
    retire(reason?: string): Promise<void>;
    /** Idempotently dispose the mounted adapter and its in-process host boundary. */
    dispose(): Promise<void>;
}

type ActiveRequest = Readonly<{ controller: AbortController }>;
type ResourceSubscription = Readonly<{ resource: PluginReference }>;
type ComposerHostResource = Readonly<{
    method: 'watchComposer' | 'acquireComposerInputLock';
    ref: ComposerRefV1;
    controller: AbortController;
    release?: Disposable;
}>;
type PrivateSemanticTarget = Readonly<{
    fixtureRevision: number;
    adapterRevision: number;
    handle: string;
    target: PluginUiSemanticTarget;
}>;

const SEMANTIC_FIND_TIMEOUT_MS = 1_000;
const SEMANTIC_FIND_POLL_INTERVAL_MS = 20;

function fixtureError(code: string, message: string): PluginUiHostApiClientError {
    return new PluginUiHostApiClientError(code, message);
}

function unreachableSurfaceHostMethod(method: never): never {
    throw fixtureError('unsupported_method', `Unsupported host method ${method}.`);
}

function readFixtureHostFailure(error: unknown, fallbackMessage: string): PluginError {
    if (isPluginError(error)) return error;
    return fixtureError('internal_error', fallbackMessage);
}

function isJsonRecord(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
    return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: JsonValue | undefined, label: string): Readonly<Record<string, JsonValue>> {
    if (!isJsonRecord(value)) throw fixtureError('invalid_payload', `${label} must be an object.`);
    return value;
}

function requireString(value: JsonValue | undefined, label: string): string {
    if (typeof value !== 'string') throw fixtureError('invalid_payload', `${label} must be a string.`);
    return value;
}

function readResourceReference(value: JsonValue | undefined, label: string): PluginReference {
    const parsed = PluginUiResourceSubscriptionTargetV1Schema.safeParse(value);
    if (!parsed.success) throw fixtureError('invalid_payload', `${label} must be a plugin contribution reference.`);
    return parsed.data;
}

function readOptionalJson(record: Readonly<Record<string, JsonValue>>, key: string): JsonValue | undefined {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
    const parsed = PluginUiJsonValueV1Schema.safeParse(record[key]);
    if (!parsed.success) throw fixtureError('invalid_payload', `${key} must be JSON.`);
    return parsed.data;
}

function requireTransportJson(value: unknown, label: string): JsonValue {
    const parsed = PluginUiJsonValueV1Schema.safeParse(value);
    if (!parsed.success) throw fixtureError('invalid_payload', `${label} must be transport-safe JSON.`);
    return parsed.data;
}

function readOptionalString(record: Readonly<Record<string, JsonValue>>, key: string): string | undefined {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
    return requireString(record[key], key);
}

function encodeBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

function encodeResource(resource: ResourceContent): JsonValue {
    if (typeof resource.contentType !== 'string' || resource.contentType.trim() === '') {
        throw fixtureError('invalid_payload', 'Resource contentType must be non-empty.');
    }
    const digest = PluginUiArtifactDigestV1Schema.safeParse(resource.digest);
    if (!digest.success || !(resource.bytes instanceof Uint8Array)) {
        throw fixtureError('invalid_payload', 'Resource content must carry canonical bytes and digest.');
    }
    return {
        contentType: resource.contentType,
        digest: digest.data,
        bytesBase64: encodeBase64(resource.bytes),
    };
}

function freezeState(state: PluginUiSemanticState | undefined): PluginUiSemanticState | undefined {
    if (state === undefined) return undefined;
    return Object.freeze({
        ...(state.disabled === undefined ? {} : { disabled: state.disabled }),
        ...(state.busy === undefined ? {} : { busy: state.busy }),
        ...(state.selected === undefined ? {} : { selected: state.selected }),
        ...(state.checked === undefined ? {} : { checked: state.checked }),
        ...(state.expanded === undefined ? {} : { expanded: state.expanded }),
    });
}

function readSemanticSnapshot(value: unknown): PluginUiSemanticAdapterSnapshot {
    const parsed = PluginUiSemanticAdapterSnapshotSchema.safeParse(value);
    if (!parsed.success) {
        throw fixtureError('invalid_payload', 'The semantic adapter returned an invalid snapshot.');
    }
    const handles = new Set<string>();
    const nodes = parsed.data.nodes.map((node) => {
        if (handles.has(node.handle)) {
            throw fixtureError('invalid_payload', 'The semantic adapter returned duplicate handles.');
        }
        handles.add(node.handle);
        return Object.freeze({
            handle: node.handle,
            role: node.role,
            ...(node.name === undefined ? {} : { name: node.name }),
            ...(node.state === undefined ? {} : { state: freezeState(node.state) }),
            ...(node.label === undefined ? {} : { label: node.label }),
            ...(node.placeholder === undefined ? {} : { placeholder: node.placeholder }),
            ...(node.value === undefined ? {} : { value: node.value }),
            ...(node.actions === undefined ? {} : { actions: Object.freeze([...node.actions]) }),
        });
    });
    const texts = parsed.data.texts?.map((text) => Object.freeze({ content: text.content }));
    return Object.freeze({
        revision: parsed.data.revision,
        nodes: Object.freeze(nodes),
        ...(texts === undefined ? {} : { texts: Object.freeze(texts) }),
    });
}

function matchesState(actual: PluginUiSemanticState | undefined, expected: PluginUiSemanticState | undefined): boolean {
    if (expected === undefined) return true;
    return (expected.disabled === undefined || actual?.disabled === expected.disabled)
        && (expected.busy === undefined || actual?.busy === expected.busy)
        && (expected.selected === undefined || actual?.selected === expected.selected)
        && (expected.checked === undefined || actual?.checked === expected.checked)
        && (expected.expanded === undefined || actual?.expanded === expected.expanded);
}

function sameState(
    left: PluginUiSemanticState | undefined,
    right: PluginUiSemanticState | undefined,
): boolean {
    return left?.disabled === right?.disabled
        && left?.busy === right?.busy
        && left?.selected === right?.selected
        && left?.checked === right?.checked
        && left?.expanded === right?.expanded;
}

function semanticTargetFromNode(node: PluginUiSemanticAdapterNode): PluginUiSemanticTarget {
    return Object.freeze({
        role: node.role,
        ...(node.name === undefined ? {} : { name: node.name }),
        ...(node.state === undefined ? {} : { state: node.state }),
        ...(node.label === undefined ? {} : { label: node.label }),
        ...(node.placeholder === undefined ? {} : { placeholder: node.placeholder }),
        ...(node.value === undefined ? {} : { value: node.value }),
    });
}

function matchesSemanticQuery(
    node: PluginUiSemanticAdapterNode,
    requested: PluginUiSemanticTarget,
): boolean {
    return node.role === requested.role
        && (requested.name === undefined || node.name === requested.name)
        && matchesState(node.state, requested.state)
        && (requested.label === undefined || node.label === requested.label)
        && (requested.placeholder === undefined || node.placeholder === requested.placeholder)
        && (requested.value === undefined || node.value === requested.value);
}

function sameSemanticTarget(
    left: PluginUiSemanticTarget,
    right: PluginUiSemanticTarget,
): boolean {
    return left.role === right.role
        && left.name === right.name
        && sameState(left.state, right.state)
        && left.label === right.label
        && left.placeholder === right.placeholder
        && left.value === right.value;
}

function sleepForSemanticQuery(milliseconds: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

function sameReference(left: PluginReference, right: PluginReference, pluginId: string): boolean {
    const key = (value: PluginReference): string => (
        typeof value === 'string'
            ? `${pluginId}\u0000${value}`
            : `${value.pluginId}\u0000${value.localId}`
    );
    return key(left) === key(right);
}

function readComposerHostResourceRelease(value: void | Disposable): Disposable | undefined {
    if (value === undefined) return undefined;
    if (typeof value.dispose !== 'function') {
        throw fixtureError('invalid_payload', 'A Composer resource release must expose dispose().');
    }
    return value;
}

function normalizedReason(reason: string | undefined): string {
    const value = reason?.trim();
    return value && value.length > 0 ? value : 'stale_surface';
}

/**
 * Create a deterministic in-process host boundary for author UI tests.
 *
 * The fixture deliberately drives the same host-API client an authored surface
 * receives. It is not a renderer, resource store, artifact cache, or platform
 * emulator: those remain with their owning host/framework layers.
 */
export function createPluginUiTestkit<TSurface>(
    options: PluginUiTestkitOptions<TSurface>,
): Promise<PluginUiTestkit>;

export function createPluginUiTestkit<TSurface>(
    options: PluginUiTestkitMountOptions<TSurface>,
): Promise<PluginUiTestkitMountResult>;

export async function createPluginUiTestkit<TSurface>(
    options: PluginUiTestkitOptions<TSurface> | PluginUiTestkitMountOptions<TSurface>,
): Promise<PluginUiTestkit | PluginUiTestkitMountResult> {
    if (options.mount !== undefined) {
        const availability = DaemonPluginUiTargetedSurfaceRendererAvailabilityV1Schema.parse(options.mount.availability);
        if (availability.state !== 'available') {
            return Object.freeze({ kind: 'refused', availability: Object.freeze(availability) });
        }
        const fixture = await createPluginUiTestkitInternal(options);
        return Object.freeze({ kind: 'mounted', fixture });
    }
    return await createPluginUiTestkitInternal(options);
}

async function createPluginUiTestkitInternal<TSurface>(
    options: Omit<PluginUiTestkitOptions<TSurface>, 'mount'>,
): Promise<PluginUiTestkit> {
    const identity = PluginUiHostApiWireIdentityV1Schema.parse(options.identity);
    const launchInput = options.launchInput === undefined
        ? undefined
        : PluginUiJsonValueV1Schema.parse(options.launchInput);
    // The page location is fixture STATE, not a construction constant: the real
    // host settles a replacement and re-renders the page with the location it
    // settled on, and it also changes the location for navigation the page did
    // not perform — system Back being the one every full-page surface has to
    // answer. A location captured once made both of those untestable, so a
    // surface that reads `subPath` as its input could only ever be mounted at
    // one location.
    let currentSubPath = options.subPath === undefined
        ? undefined
        : PluginUiSubPathV1Schema.parse(options.subPath);
    const handlers = options.handlers ?? {};
    const listeners = new Set<(message: unknown) => void>();
    const activeRequests = new Map<string, ActiveRequest>();
    const contextSubscriptions = new Set<string>();
    const resourceSubscriptions = new Map<string, ResourceSubscription>();
    const composerHostResources = new Map<string, ComposerHostResource>();
    const lifetime = new AbortController();
    const targets = new WeakMap<PluginUiSemanticTarget, PrivateSemanticTarget>();
    let active = true;
    let negotiated = false;
    let negotiatedApiVersion: typeof PLUGIN_UI_HOST_API_VERSION_V1 | undefined;
    let semanticMount: PluginUiSemanticSurfaceMount | undefined;
    let retirement: Promise<void> | undefined;
    let fixtureRevision = 1;
    // The fixture host owns one current context snapshot from admission onward.
    // Negotiation and the later canonical `context` request must project this
    // exact fact; the client must never be asked to supply a fallback value.
    let currentSurface = options.surfaceContext;

    const methods = PLUGIN_UI_HOST_METHODS_V1
        .filter((method) => isHostMethodAvailable(method, handlers));

    function emit(envelope: PluginUiHostApiWireEnvelopeV1): void {
        const parsed = PluginUiHostApiWireEnvelopeV1Schema.parse(envelope);
        for (const listener of listeners) listener(parsed);
    }

    function assertActive(): void {
        if (!active) throw fixtureError('stale_surface', 'The plugin UI fixture generation is retired.');
    }

    function sendFailure(
        message: Extract<PluginUiHostApiWireEnvelopeV1, { kind: 'request' | 'subscribe' }>,
        code: string,
        failureMessage: string,
    ): void {
        if (!active) return;
        emit({
            wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
            kind: 'error',
            identity,
            requestId: message.requestId,
            method: message.method,
            error: { name: 'PluginError', code, message: failureMessage },
        });
    }

    function sendResult(
        message: Extract<PluginUiHostApiWireEnvelopeV1, { kind: 'request' | 'subscribe' }>,
        result?: JsonValue,
    ): void {
        if (!active) return;
        emit({
            wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
            kind: 'result',
            identity,
            requestId: message.requestId,
            method: message.method,
            ...(result === undefined ? {} : { result }),
        });
    }

    async function retireComposerHostResource(
        resource: ComposerHostResource,
        reason: string,
    ): Promise<void> {
        if (!resource.controller.signal.aborted) resource.controller.abort(reason);
        await resource.release?.dispose();
    }

    function disposeComposerHostResource(subscriptionId: string, reason: string): Promise<void> {
        const resource = composerHostResources.get(subscriptionId);
        if (!resource) return Promise.resolve();
        composerHostResources.delete(subscriptionId);
        return retireComposerHostResource(resource, reason);
    }

    function retireInternal(reason: string, notifyClient: boolean): Promise<void> {
        if (retirement) return retirement;
        active = false;
        lifetime.abort(reason);
        for (const request of activeRequests.values()) request.controller.abort(reason);
        activeRequests.clear();
        contextSubscriptions.clear();
        resourceSubscriptions.clear();
        const composerResources = [...composerHostResources.values()];
        composerHostResources.clear();
        const mounted = semanticMount;
        retirement = (async () => {
            await Promise.all([
                ...(mounted ? [mounted.dispose()] : []),
                ...composerResources.map((resource) => retireComposerHostResource(resource, reason)),
            ]);
        })();
        if (notifyClient) {
            emit({ wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1, kind: 'disconnected', identity, reason });
        }
        return retirement;
    }

    function renderContext(surface: SurfaceContext, hostApi: RenderContext['hostApi']): RenderContext {
        const context: RenderContext = {
            plugin: Object.freeze({ id: identity.pluginId, version: identity.pluginVersion }),
            surface,
            hostApi,
            signal: lifetime.signal,
            ...(launchInput === undefined ? {} : { launchInput }),
            ...(currentSubPath === undefined ? {} : { subPath: currentSubPath }),
        };
        return Object.freeze(context);
    }

    async function handleRequest(
        message: Extract<PluginUiHostApiWireEnvelopeV1, { kind: 'request' }>,
        signal: AbortSignal,
    ): Promise<JsonValue | undefined> {
        assertActive();
        switch (message.method) {
            case 'context':
                return currentSurface;
            case 'publishCurrentUiContext': {
                if (!handlers.publishCurrentUiContext) {
                    throw fixtureError('unsupported_method', 'publishCurrentUiContext is not installed.');
                }
                const payload = PluginUiPublishCurrentUiContextRequestV1Schema.safeParse(message.payload);
                if (!payload.success) {
                    throw fixtureError('invalid_payload', 'publishCurrentUiContext payload is invalid.');
                }
                await handlers.publishCurrentUiContext({ enrichment: payload.data.enrichment, signal });
                return undefined;
            }
            case 'executeAction': {
                if (!handlers.executeAction) throw fixtureError('unsupported_method', 'executeAction is not installed.');
                const payload = PluginUiExecuteActionRequestV1Schema.safeParse(message.payload);
                if (!payload.success) throw fixtureError('invalid_payload', 'executeAction payload is invalid.');
                const selectedActionInput = (
                    message.targetedOperation === undefined && message.selectedActionInput === undefined
                )
                    ? undefined
                    : PluginUiSelectedActionInputCarrierV1Schema.safeParse({
                        operation: message.targetedOperation,
                        result: message.selectedActionInput,
                    });
                if (selectedActionInput !== undefined && !selectedActionInput.success) {
                    throw fixtureError('invalid_payload', 'executeAction selected Action input is invalid.');
                }
                return await handlers.executeAction({
                    action: payload.data.action,
                    input: payload.data.input ?? null,
                    ...(selectedActionInput === undefined ? {} : { selectedActionInput: selectedActionInput.data }),
                    ...(message.consumeSelectedActionInput === undefined
                        ? {}
                        : { consumeSelectedActionInput: message.consumeSelectedActionInput }),
                    signal,
                });
            }
            case 'selectActionInput': {
                if (!handlers.selectActionInput) {
                    throw fixtureError('unsupported_method', 'selectActionInput is not installed.');
                }
                const payload = PluginUiSelectActionInputRequestV1Schema.safeParse(message.payload);
                if (!payload.success) {
                    throw fixtureError('invalid_payload', 'selectActionInput payload is invalid.');
                }
                const result = PluginUiSelectActionInputResultV1Schema.safeParse(
                    await handlers.selectActionInput({ request: payload.data, signal }),
                );
                if (!result.success) {
                    throw fixtureError('invalid_payload', 'selectActionInput result is invalid.');
                }
                const wireResult = PluginUiJsonValueV1Schema.safeParse(result.data);
                if (!wireResult.success) {
                    throw fixtureError('invalid_payload', 'selectActionInput result is not transport-safe JSON.');
                }
                return wireResult.data;
            }
            case 'readResource': {
                if (!handlers.readResource) throw fixtureError('unsupported_method', 'readResource is not installed.');
                const payload = requireRecord(message.payload, 'readResource payload');
                return encodeResource(await handlers.readResource({
                    resource: readResourceReference(payload.resource, 'resource'),
                    signal,
                }));
            }
            case 'statOpenableContent': {
                if (!handlers.statOpenableContent) {
                    throw fixtureError('unsupported_method', 'statOpenableContent is not installed.');
                }
                const payload = requireRecord(message.payload, 'statOpenableContent payload');
                const ref = OpenableContentRefV1Schema.safeParse(payload.ref);
                if (!ref.success) throw fixtureError('invalid_payload', 'statOpenableContent reference is invalid.');
                return await handlers.statOpenableContent({ ref: ref.data, signal });
            }
            case 'readOpenableContent': {
                if (!handlers.readOpenableContent) {
                    throw fixtureError('unsupported_method', 'readOpenableContent is not installed.');
                }
                const request = OpenableContentReadRequestV1Schema.safeParse(message.payload);
                if (!request.success) throw fixtureError('invalid_payload', 'readOpenableContent request is invalid.');
                return await handlers.readOpenableContent({ request: request.data, signal });
            }
            case 'activeComposer': {
                if (!handlers.activeComposer) throw fixtureError('unsupported_method', 'activeComposer is not installed.');
                const result = PluginUiActiveComposerResultV1Schema.safeParse(
                    await handlers.activeComposer({ signal }),
                );
                if (!result.success) throw fixtureError('invalid_payload', 'activeComposer result is invalid.');
                return requireTransportJson(result.data, 'activeComposer result');
            }
            case 'readComposer': {
                if (!handlers.readComposer) throw fixtureError('unsupported_method', 'readComposer is not installed.');
                const payload = PluginUiReadComposerRequestV1Schema.safeParse(message.payload);
                if (!payload.success) throw fixtureError('invalid_payload', 'readComposer payload is invalid.');
                const result = PluginUiReadComposerResultV1Schema.safeParse(
                    await handlers.readComposer({ ref: payload.data.ref, signal }),
                );
                if (!result.success) throw fixtureError('invalid_payload', 'readComposer result is invalid.');
                return requireTransportJson(result.data, 'readComposer result');
            }
            case 'applyComposer': {
                if (!handlers.applyComposer) throw fixtureError('unsupported_method', 'applyComposer is not installed.');
                const payload = PluginUiApplyComposerRequestV1Schema.safeParse(message.payload);
                if (!payload.success) throw fixtureError('invalid_payload', 'applyComposer payload is invalid.');
                const result = PluginUiApplyComposerResultV1Schema.safeParse(
                    await handlers.applyComposer({
                        ref: payload.data.ref,
                        transaction: payload.data.transaction,
                        signal,
                    }),
                );
                if (!result.success) throw fixtureError('invalid_payload', 'applyComposer result is invalid.');
                return requireTransportJson(result.data, 'applyComposer result');
            }
            case 'focusComposer': {
                if (!handlers.focusComposer) throw fixtureError('unsupported_method', 'focusComposer is not installed.');
                const payload = PluginUiFocusComposerRequestV1Schema.safeParse(message.payload);
                if (!payload.success) throw fixtureError('invalid_payload', 'focusComposer payload is invalid.');
                const result = PluginUiFocusComposerResultV1Schema.safeParse(
                    await handlers.focusComposer({ ref: payload.data.ref, signal }),
                );
                if (!result.success) throw fixtureError('invalid_payload', 'focusComposer result is invalid.');
                return requireTransportJson(result.data, 'focusComposer result');
            }
            case 'setComposerDecorations': {
                if (!handlers.setComposerDecorations) {
                    throw fixtureError('unsupported_method', 'setComposerDecorations is not installed.');
                }
                const payload = PluginUiSetComposerDecorationsRequestV1Schema.safeParse(message.payload);
                if (!payload.success) throw fixtureError('invalid_payload', 'setComposerDecorations payload is invalid.');
                const result = PluginUiSetComposerDecorationsResultV1Schema.safeParse(
                    await handlers.setComposerDecorations({
                        ref: payload.data.ref,
                        key: payload.data.key,
                        decorations: payload.data.decorations,
                        signal,
                    }),
                );
                if (!result.success) throw fixtureError('invalid_payload', 'setComposerDecorations result is invalid.');
                return requireTransportJson(result.data, 'setComposerDecorations result');
            }
            case 'pickComposerMedia': {
                if (!handlers.pickComposerMedia) {
                    throw fixtureError('unsupported_method', 'pickComposerMedia is not installed.');
                }
                const payload = PluginUiPickComposerMediaRequestV1Schema.safeParse(message.payload);
                if (!payload.success) throw fixtureError('invalid_payload', 'pickComposerMedia payload is invalid.');
                const result = PluginUiPickComposerMediaResultV1Schema.safeParse(
                    await handlers.pickComposerMedia({
                        ref: payload.data.ref,
                        request: payload.data.request,
                        signal,
                    }),
                );
                if (!result.success) throw fixtureError('invalid_payload', 'pickComposerMedia result is invalid.');
                return requireTransportJson(result.data, 'pickComposerMedia result');
            }
            case 'inspectComposerContent': {
                if (!handlers.inspectComposerContent) {
                    throw fixtureError('unsupported_method', 'inspectComposerContent is not installed.');
                }
                const payload = PluginUiInspectComposerContentRequestV1Schema.safeParse(message.payload);
                if (!payload.success) throw fixtureError('invalid_payload', 'inspectComposerContent payload is invalid.');
                const result = await handlers.inspectComposerContent({
                    handle: payload.data.handle,
                    request: payload.data.request,
                    signal,
                });
                if (!(result.bytes instanceof Uint8Array)) {
                    throw fixtureError('invalid_payload', 'inspectComposerContent result must contain bytes.');
                }
                const wireResult = PluginUiInspectComposerContentResultV1Schema.safeParse({
                    offset: result.offset,
                    bytesBase64: encodeBase64(result.bytes),
                    eof: result.eof,
                });
                if (!wireResult.success) {
                    throw fixtureError('invalid_payload', 'inspectComposerContent result is invalid.');
                }
                return requireTransportJson(wireResult.data, 'inspectComposerContent result');
            }
            case 'releaseComposerContent': {
                if (!handlers.releaseComposerContent) {
                    throw fixtureError('unsupported_method', 'releaseComposerContent is not installed.');
                }
                const payload = PluginUiReleaseComposerContentRequestV1Schema.safeParse(message.payload);
                if (!payload.success) throw fixtureError('invalid_payload', 'releaseComposerContent payload is invalid.');
                await handlers.releaseComposerContent({ handle: payload.data.handle, signal });
                return undefined;
            }
            case 'openSurface': {
                if (!handlers.openSurface) throw fixtureError('unsupported_method', 'openSurface is not installed.');
                const payload = PluginUiOpenSurfaceRequestV1Schema.safeParse(message.payload);
                if (!payload.success) throw fixtureError('invalid_payload', 'openSurface payload is invalid.');
                await handlers.openSurface({
                    view: payload.data.destination,
                    ...(payload.data.input === undefined ? {} : { input: payload.data.input }),
                    ...(payload.data.subPath === undefined ? {} : { subPath: payload.data.subPath }),
                    ...(payload.data.instanceKey === undefined ? {} : { instanceKey: payload.data.instanceKey }),
                    signal,
                });
                return undefined;
            }
            case 'notify': {
                if (!handlers.notify) throw fixtureError('unsupported_method', 'notify is not installed.');
                const payload = requireRecord(message.payload, 'notify payload');
                const severity = readOptionalString(payload, 'severity');
                if (severity !== undefined && severity !== 'info' && severity !== 'warning' && severity !== 'error') {
                    throw fixtureError('invalid_payload', 'notify severity is invalid.');
                }
                await handlers.notify({
                    message: requireString(payload.message, 'message'),
                    ...(severity === undefined ? {} : { severity }),
                    signal,
                });
                return undefined;
            }
            case 'confirm': {
                if (!handlers.confirm) throw fixtureError('unsupported_method', 'confirm is not installed.');
                const payload = requireRecord(message.payload, 'confirm payload');
                const confirmed = await handlers.confirm({
                    message: requireString(payload.message, 'message'),
                    ...(readOptionalString(payload, 'title') === undefined ? {} : { title: readOptionalString(payload, 'title')! }),
                    signal,
                });
                if (typeof confirmed !== 'boolean') throw fixtureError('invalid_payload', 'confirm must resolve a boolean.');
                return { confirmed };
            }
            case 'diagnostic': {
                if (!handlers.diagnostic) throw fixtureError('unsupported_method', 'diagnostic is not installed.');
                const parsed = PluginUiHostApiDiagnosticV1Schema.safeParse(message.payload);
                if (!parsed.success) {
                    throw fixtureError('invalid_payload', 'diagnostic payload is invalid.');
                }
                await handlers.diagnostic({
                    data: parsed.data,
                    signal,
                });
                return undefined;
            }
            case 'readClipboard': {
                if (!handlers.readClipboard) throw fixtureError('unsupported_method', 'readClipboard is not installed.');
                const value = await handlers.readClipboard({ signal });
                if (typeof value !== 'string') throw fixtureError('invalid_payload', 'readClipboard must resolve a string.');
                return { value };
            }
            case 'writeClipboard': {
                if (!handlers.writeClipboard) throw fixtureError('unsupported_method', 'writeClipboard is not installed.');
                const payload = PluginUiHostApiWriteClipboardRequestV1Schema.safeParse(message.payload);
                if (!payload.success) throw fixtureError('invalid_payload', 'writeClipboard payload is invalid.');
                await handlers.writeClipboard({ value: payload.data.value, signal });
                return undefined;
            }
            case 'replacePageLocation': {
                if (!handlers.replacePageLocation) throw fixtureError('unsupported_method', 'replacePageLocation is not installed.');
                const payload = PluginUiReplacePageLocationRequestV1Schema.safeParse(message.payload);
                if (!payload.success) throw fixtureError('invalid_payload', 'replacePageLocation payload is invalid.');
                const settled = await handlers.replacePageLocation({
                    subPath: payload.data.subPath,
                    ...(payload.data.backLocation === undefined
                        ? {}
                        : { backLocation: payload.data.backLocation }),
                    signal,
                });
                if (typeof settled !== 'string') throw fixtureError('invalid_payload', 'replacePageLocation must resolve the settled location.');
                return { subPath: settled };
            }
            case 'openExternalLink': {
                if (!handlers.openExternalLink) throw fixtureError('unsupported_method', 'openExternalLink is not installed.');
                const payload = PluginUiHostApiOpenExternalLinkRequestV1Schema.safeParse(message.payload);
                if (!payload.success) throw fixtureError('invalid_payload', 'openExternalLink payload is invalid.');
                await handlers.openExternalLink({ url: payload.data.url, signal });
                return undefined;
            }
            case 'watchContext':
            case 'watchResource':
            case 'watchComposer':
            case 'acquireComposerInputLock':
                throw fixtureError('unsupported_method', `${message.method} must be established as a subscription.`);
            default:
                return unreachableSurfaceHostMethod(message.method);
        }
    }

    async function dispatchRequest(message: Extract<PluginUiHostApiWireEnvelopeV1, { kind: 'request' }>): Promise<void> {
        const controller = new AbortController();
        activeRequests.set(message.requestId, { controller });
        try {
            const result = await handleRequest(message, controller.signal);
            if (!controller.signal.aborted) sendResult(message, result);
        } catch (error) {
            if (!controller.signal.aborted) {
                const failure = readFixtureHostFailure(error, 'A plugin UI test host handler failed.');
                sendFailure(message, failure.code, failure.message);
            }
        } finally {
            activeRequests.delete(message.requestId);
        }
    }

    async function dispatchSubscription(message: Extract<PluginUiHostApiWireEnvelopeV1, { kind: 'subscribe' }>): Promise<void> {
        const controller = new AbortController();
        activeRequests.set(message.requestId, { controller });
        try {
            assertActive();
            let establishment: JsonValue | undefined;
            switch (message.method) {
                case 'watchContext':
                    contextSubscriptions.add(message.subscriptionId);
                    break;
                case 'watchResource': {
                    if (!handlers.watchResource) {
                        throw fixtureError('unsupported_method', 'watchResource is not installed.');
                    }
                    const payload = requireRecord(message.payload, 'watchResource payload');
                    const resource = readResourceReference(payload.resource, 'resource');
                    const watch = await handlers.watchResource({ resource, signal: controller.signal });
                    if (controller.signal.aborted) return;
                    resourceSubscriptions.set(message.subscriptionId, { resource });
                    establishment = {
                        subscriptionId: message.subscriptionId,
                        digest: PluginUiArtifactDigestV1Schema.parse(watch.digest),
                    };
                    break;
                }
                case 'watchComposer': {
                    if (!handlers.watchComposer) {
                        throw fixtureError('unsupported_method', 'watchComposer is not installed.');
                    }
                    const payload = PluginUiWatchComposerRequestV1Schema.safeParse(message.payload);
                    if (!payload.success) throw fixtureError('invalid_payload', 'watchComposer payload is invalid.');
                    const release = readComposerHostResourceRelease(await handlers.watchComposer({
                        ref: payload.data.ref,
                        signal: controller.signal,
                    }));
                    const resource: ComposerHostResource = {
                        method: 'watchComposer',
                        ref: payload.data.ref,
                        controller,
                        ...(release === undefined ? {} : { release }),
                    };
                    if (controller.signal.aborted || !active) {
                        await retireComposerHostResource(resource, 'aborted');
                        return;
                    }
                    composerHostResources.set(message.subscriptionId, Object.freeze(resource));
                    break;
                }
                case 'acquireComposerInputLock': {
                    if (!handlers.acquireComposerInputLock) {
                        throw fixtureError('unsupported_method', 'acquireComposerInputLock is not installed.');
                    }
                    const payload = PluginUiAcquireComposerInputLockRequestV1Schema.safeParse(message.payload);
                    if (!payload.success) {
                        throw fixtureError('invalid_payload', 'acquireComposerInputLock payload is invalid.');
                    }
                    const release = readComposerHostResourceRelease(await handlers.acquireComposerInputLock({
                        ref: payload.data.ref,
                        request: payload.data.request,
                        signal: controller.signal,
                    }));
                    const resource: ComposerHostResource = {
                        method: 'acquireComposerInputLock',
                        ref: payload.data.ref,
                        controller,
                        ...(release === undefined ? {} : { release }),
                    };
                    if (controller.signal.aborted || !active) {
                        await retireComposerHostResource(resource, 'aborted');
                        return;
                    }
                    composerHostResources.set(message.subscriptionId, Object.freeze(resource));
                    break;
                }
                default:
                    return unreachableSurfaceHostMethod(message.method);
            }
            sendResult(message, establishment);
        } catch (error) {
            if (!controller.signal.aborted) {
                const failure = readFixtureHostFailure(error, 'A plugin UI test host subscription failed.');
                sendFailure(message, failure.code, failure.message);
            }
        } finally {
            activeRequests.delete(message.requestId);
        }
    }

    function receive(raw: PluginUiHostApiWireEnvelopeV1): void {
        const parsed = PluginUiHostApiWireEnvelopeV1Schema.safeParse(raw);
        if (!parsed.success) {
            void retireInternal('invalid_payload', true);
            return;
        }
        const message = parsed.data;
        if (!active) return;
        if (message.kind === 'negotiate') {
            if (negotiated) {
                void retireInternal('invalid_negotiation', true);
                return;
            }
            const apiVersion = isPluginUiHostApiVersionCompatibleV1(message.apiRange)
                ? PLUGIN_UI_HOST_API_VERSION_V1
                : null;
            if (!apiVersion) {
                emit({
                    wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
                    kind: 'disconnected',
                    identity,
                    reason: 'incompatible_api_version',
                });
                void retireInternal('incompatible_api_version', true);
                return;
            }
            const negotiatedMethods = methods;
            negotiated = true;
            negotiatedApiVersion = apiVersion;
            emit({
                wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
                kind: 'negotiated',
                identity,
                apiVersion,
                methods: negotiatedMethods,
                surface: currentSurface,
            });
            return;
        }
        if (message.kind === 'request') {
            void dispatchRequest(message);
            return;
        }
        if (message.kind === 'subscribe') {
            void dispatchSubscription(message);
            return;
        }
        if (message.kind === 'cancel') {
            activeRequests.get(message.requestId)?.controller.abort('aborted');
            return;
        }
        if (message.kind === 'disposeHostResource') {
            contextSubscriptions.delete(message.subscriptionId);
            resourceSubscriptions.delete(message.subscriptionId);
            void disposeComposerHostResource(message.subscriptionId, 'disposed').catch(() => undefined);
        }
    }

    const hostApi = await createPluginUiHostApiClientFromTransport({
        identity,
        ...(options.apiRange === undefined ? {} : { apiRange: options.apiRange }),
        transport: {
            send(message) { receive(message); },
            subscribe(listener) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
        },
        onDisconnected(reason) {
            void retireInternal(reason, false).catch(() => undefined);
        },
    });
    const initialSurface = await hostApi.context();
    const context = renderContext(initialSurface, hostApi);
    /** The surface fact currently rendered, so a location-only change keeps it. */
    let renderedSurface: SurfaceContext = initialSurface;
    try {
        semanticMount = await options.adapter.mount({ surface: options.surface, context, signal: lifetime.signal });
    } catch (error) {
        await retireInternal('semantic_adapter_mount_failed', true).catch(() => undefined);
        throw error;
    }
    assertActive();

    async function snapshot(): Promise<PluginUiSemanticAdapterSnapshot> {
        assertActive();
        if (!semanticMount) throw fixtureError('stale_surface', 'The semantic surface mount is unavailable.');
        const adapterSnapshot = await semanticMount.snapshot();
        assertActive();
        return readSemanticSnapshot(adapterSnapshot);
    }

    function readQuery(role: PluginUiSemanticRole, options: PluginUiSemanticQueryOptions | undefined): PluginUiSemanticTarget {
        const parsed = PluginUiSemanticTargetSchema.safeParse({ role, ...(options ?? {}) });
        if (!parsed.success) throw fixtureError('invalid_payload', 'The semantic query is invalid.');
        return Object.freeze({
            role: parsed.data.role,
            ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
            ...(parsed.data.state === undefined ? {} : { state: freezeState(parsed.data.state) }),
            ...(parsed.data.label === undefined ? {} : { label: parsed.data.label }),
            ...(parsed.data.placeholder === undefined ? {} : { placeholder: parsed.data.placeholder }),
            ...(parsed.data.value === undefined ? {} : { value: parsed.data.value }),
        });
    }

    function readTextQuery(content: string): PluginUiSemanticTextTarget {
        const parsed = PluginUiSemanticTextTargetSchema.safeParse({ content });
        if (!parsed.success) throw fixtureError('invalid_payload', 'The semantic text query is invalid.');
        return Object.freeze({ content: parsed.data.content });
    }

    function retainTarget(
        node: PluginUiSemanticAdapterNode,
        adapterRevision: number,
    ): PluginUiSemanticTarget {
        const target = semanticTargetFromNode(node);
        targets.set(target, {
            fixtureRevision,
            adapterRevision,
            handle: node.handle,
            target,
        });
        return target;
    }

    async function queryAll(
        role: PluginUiSemanticRole,
        options: PluginUiSemanticQueryOptions | undefined,
    ): Promise<readonly PluginUiSemanticTarget[]> {
        const requested = readQuery(role, options);
        const current = await snapshot();
        return Object.freeze(
            current.nodes
                .filter((node) => matchesSemanticQuery(node, requested))
                .map((node) => retainTarget(node, current.revision)),
        );
    }

    async function query(role: PluginUiSemanticRole, options: PluginUiSemanticQueryOptions | undefined): Promise<PluginUiSemanticTarget | undefined> {
        const matching = await queryAll(role, options);
        if (matching.length === 0) return undefined;
        if (matching.length > 1) {
            throw fixtureError('invalid_payload', 'The semantic query matched more than one target.');
        }
        return matching[0]!;
    }

    async function queryText(content: string): Promise<PluginUiSemanticTextTarget | undefined> {
        const requested = readTextQuery(content);
        const current = await snapshot();
        const matching = (current.texts ?? []).filter((text) => text.content === requested.content);
        if (matching.length === 0) return undefined;
        if (matching.length > 1) {
            throw fixtureError('invalid_payload', 'The semantic text query matched more than one target.');
        }
        return Object.freeze({ content: matching[0]!.content });
    }

    const fixture: PluginUiTestkit = Object.freeze({
        context,
        async updateSurface(surface: SurfaceContext) {
            assertActive();
            if (!semanticMount) throw fixtureError('stale_surface', 'The semantic surface mount is unavailable.');
            const next = renderContext(surface, hostApi);
            await semanticMount.update(next);
            assertActive();
            currentSurface = surface;
            renderedSurface = surface;
            fixtureRevision += 1;
            for (const subscriptionId of contextSubscriptions) {
                if (negotiatedApiVersion) {
                    emit({
                        wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
                        kind: 'subscription',
                        identity,
                        subscriptionId,
                        event: surface,
                    });
                }
            }
        },
        async updatePageLocation(subPath: string) {
            assertActive();
            if (!semanticMount) throw fixtureError('stale_surface', 'The semantic surface mount is unavailable.');
            // Normalized by the same owner the request schema uses, so a
            // fixture can never settle a location the real host would refuse.
            currentSubPath = PluginUiSubPathV1Schema.parse(subPath);
            await semanticMount.update(renderContext(renderedSurface, hostApi));
            assertActive();
            fixtureRevision += 1;
        },
        invalidateResource(resource: PluginReference, digest: string) {
            assertActive();
            const canonicalResource = readResourceReference(resource, 'resource');
            const canonicalDigest = PluginUiArtifactDigestV1Schema.parse(digest);
            for (const [subscriptionId, subscription] of resourceSubscriptions) {
                if (!sameReference(subscription.resource, canonicalResource, identity.pluginId)) continue;
                emit({
                    wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
                    kind: 'subscription',
                    identity,
                    subscriptionId,
                    event: { version: 1, subscriptionId, kind: 'invalidated', digest: canonicalDigest },
                });
            }
        },
        emitComposerSnapshot(ref: ComposerRefV1, snapshot: ComposerSnapshotV1) {
            assertActive();
            const canonicalRef = ComposerRefV1Schema.parse(ref);
            const canonicalSnapshot = ComposerSnapshotV1Schema.parse(snapshot);
            if (!composerRefsV1Equal(canonicalRef, canonicalSnapshot.ref)) {
                throw fixtureError('invalid_payload', 'A Composer snapshot must match its observed Composer ref.');
            }
            for (const [subscriptionId, resource] of composerHostResources) {
                if (
                    resource.method !== 'watchComposer'
                    || resource.controller.signal.aborted
                    || !composerRefsV1Equal(resource.ref, canonicalRef)
                ) {
                    continue;
                }
                emit({
                    wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
                    kind: 'subscription',
                    identity,
                    subscriptionId,
                    event: canonicalSnapshot,
                });
            }
        },
        async getByRole(role: PluginUiSemanticRole, options?: PluginUiSemanticQueryOptions) {
            const target = await query(role, options);
            if (target === undefined) throw fixtureError('invalid_payload', 'The semantic target was not found.');
            return target;
        },
        async queryByRole(role: PluginUiSemanticRole, options?: PluginUiSemanticQueryOptions) {
            return await query(role, options);
        },
        async getAllByRole(role: PluginUiSemanticRole, options?: PluginUiSemanticQueryOptions) {
            const targetsForRole = await queryAll(role, options);
            if (targetsForRole.length === 0) {
                throw fixtureError('invalid_payload', 'The semantic targets were not found.');
            }
            return targetsForRole;
        },
        async queryAllByRole(role: PluginUiSemanticRole, options?: PluginUiSemanticQueryOptions) {
            return await queryAll(role, options);
        },
        async findByRole(role: PluginUiSemanticRole, options?: PluginUiSemanticQueryOptions) {
            const deadline = Date.now() + SEMANTIC_FIND_TIMEOUT_MS;
            for (;;) {
                const target = await query(role, options);
                if (target !== undefined) return target;
                const remaining = deadline - Date.now();
                if (remaining <= 0) {
                    throw fixtureError('invalid_payload', 'The semantic target was not found before the fixture timeout.');
                }
                await sleepForSemanticQuery(Math.min(SEMANTIC_FIND_POLL_INTERVAL_MS, remaining));
                assertActive();
            }
        },
        async getByText(content: string) {
            const target = await queryText(content);
            if (target === undefined) throw fixtureError('invalid_payload', 'The semantic text target was not found.');
            return target;
        },
        async queryByText(content: string) {
            return await queryText(content);
        },
        async press(target: PluginUiSemanticTarget) {
            assertActive();
            const privateTarget = targets.get(target);
            if (!privateTarget || privateTarget.fixtureRevision !== fixtureRevision) {
                throw fixtureError('stale_surface', 'The semantic target belongs to a stale surface revision.');
            }
            const current = await snapshot();
            if (current.revision !== privateTarget.adapterRevision) {
                throw fixtureError('stale_surface', 'The semantic target belongs to a stale adapter revision.');
            }
            const node = current.nodes.find((candidate) => candidate.handle === privateTarget.handle);
            if (!node || !node.actions?.includes('press')) {
                throw fixtureError('stale_surface', 'The semantic target is no longer pressable.');
            }
            if (!sameSemanticTarget(semanticTargetFromNode(node), privateTarget.target)) {
                throw fixtureError('stale_surface', 'The semantic target no longer names the same control.');
            }
            if (!semanticMount) throw fixtureError('stale_surface', 'The semantic surface mount is unavailable.');
            await semanticMount.invoke({
                revision: privateTarget.adapterRevision,
                handle: privateTarget.handle,
                action: 'press',
                target: privateTarget.target,
            });
        },
        async retire(reason?: string) {
            await retireInternal(normalizedReason(reason), true);
        },
        async dispose() {
            await retireInternal('fixture_disposed', true);
        },
    });
    return fixture;
}
