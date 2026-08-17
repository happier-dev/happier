import type { QualifiedConnectedAccountRef } from '../connectedAccounts.js';
import type { ComposerStagedMediaContentV1 } from '../composer.js';
import type { JsonValue, PluginJsonValueV2 } from '../identity.js';
import type { PluginLocalizedStringV2 } from '../manifest.js';

/** Type-only public projection; Host API payloads remain ordinary JSON values. */
type DeepReadonly<T> = T extends readonly (infer TItem)[]
    ? readonly DeepReadonly<TItem>[]
    : T extends object
        ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
        : T;

export type {
    ComposerContentHandleV1,
    ComposerContentInspectRequestV1,
    ComposerContentInspectResultV1,
    ComposerContentMediaKindV1,
    ComposerContentMimeTypeV1,
    ComposerContentPickMediaRequestV1,
    ComposerMediaContentCapabilityV1,
    ComposerSessionMediaContentV1,
    ComposerStagedMediaContentV1,
} from '../composer.js';

/**
 * Declaration-only projections for public UI author contracts.
 *
 * Protocol remains the sole parser, normalizer, and runtime-value owner. These
 * structural spellings keep public SDK declarations portable without exposing
 * Protocol or validator implementation types.
 */
export type PluginUiSchema<T> = Readonly<{
    parse(value: unknown): T;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: T }>
        | Readonly<{ success: false; error: unknown }>;
}>;

export type PluginUiJsonValueV1 = JsonValue;
export type PluginUiJsonObjectV1 = { readonly [key: string]: PluginUiJsonValueV1 };

export type PluginUiPlatform = 'android' | 'desktop' | 'ios' | 'web';
export type PluginUiChannel = 'development' | 'desktop' | 'internal' | 'store';

export type PluginUiIconTokenV1 =
    | 'action'
    | 'browser'
    | 'copy'
    | 'file'
    | 'globe'
    | 'info'
    | 'preview'
    | 'refresh'
    | 'settings'
    | 'terminal'
    | 'warning'
    | 'add'
    | 'back'
    | 'check'
    | 'close'
    | 'error'
    | 'external'
    | 'forward'
    | 'more'
    | 'search';

export type PluginUiHostMethodV1 =
    | 'context'
    | 'watchContext'
    | 'executeAction'
    | 'readResource'
    | 'statOpenableContent'
    | 'readOpenableContent'
    | 'watchResource'
    | 'openSurface'
    | 'replacePageLocation'
    | 'notify'
    | 'confirm'
    | 'diagnostic'
    | 'readClipboard'
    | 'writeClipboard'
    | 'openExternalLink'
    | 'selectActionInput'
    | 'activeComposer'
    | 'readComposer'
    | 'watchComposer'
    | 'applyComposer'
    | 'focusComposer'
    | 'setComposerDecorations'
    | 'acquireComposerInputLock'
    | 'pickComposerMedia'
    | 'inspectComposerContent'
    | 'releaseComposerContent';

export type PluginUiContributionIdentityV1 = Readonly<{
    pluginId: string;
    localId: string;
}>;

export type PluginUiContainerV1 =
    | 'appPage'
    | 'settingsPage'
    | 'rightSidebarTab'
    | 'rightPane'
    | 'detailsTab'
    | 'detailsPane'
    | 'bottomPane'
    | 'browserPanel'
    | 'servicesPanel';

export type PluginUiMountContextV1 =
    | Readonly<{
        kind: 'destination';
        destination: PluginUiContributionIdentityV1;
        container: PluginUiContainerV1;
    }>
    | Readonly<{
        kind: 'embedded';
        role: string;
        presentation: 'content' | 'fill';
    }>;

/** SDK-local declaration projection of the Protocol-owned mounted target. */
export type PluginUiHostApiSurfaceTargetV1 =
    | { kind: 'app' }
    | { kind: 'session'; sessionId: string; agentId?: string }
    | { kind: 'project'; projectId: string }
    | { kind: 'browser'; targetId: string; origin?: string }
    | { kind: 'services' };

type PluginUiHostApiSurfaceTypographyMetricV1 = {
    fontSize: number;
    lineHeight: number;
    fontWeight: string;
};

/** SDK-local declaration projection of the Protocol-owned semantic theme. */
export type PluginUiHostApiSurfaceThemeV1 = {
    version: 1;
    colors: {
        canvas: string;
        surface: string;
        elevatedSurface: string;
        text: string;
        secondaryText: string;
        mutedText: string;
        border: string;
        divider: string;
        focus: string;
        accent: string;
        onAccent: string;
        success: string;
        warning: string;
        danger: string;
        info: string;
        control: string;
        controlDisabled: string;
        overlay: string;
    };
    spacing: {
        xsmall: number;
        small: number;
        medium: number;
        large: number;
        xlarge: number;
    };
    radii: {
        small: number;
        control: number;
        panel: number;
        pill: number;
    };
    typography: {
        body: PluginUiHostApiSurfaceTypographyMetricV1;
        label: PluginUiHostApiSurfaceTypographyMetricV1;
        title: PluginUiHostApiSurfaceTypographyMetricV1;
        caption: PluginUiHostApiSurfaceTypographyMetricV1;
        code: {
            fontSize: number;
            lineHeight: number;
            fontFamily?: string;
        };
    };
};

export type PluginUiTargetedContributionProtocolV1 = Readonly<{
    id: string;
    version: number;
}>;

export type PluginUiTargetedContributionPointRefV1 = Readonly<{
    pointId: string;
    protocol: PluginUiTargetedContributionProtocolV1;
}>;

export type PluginUiTargetedContributionTargetV1 = Readonly<{
    pluginId: string;
    immutableGenerationId: string;
}>;

export type PluginUiTargetedContributionContributorV1 = Readonly<{
    pluginId: string;
    contributionId: string;
    immutableGenerationId: string;
}>;

/** Exact-generation operation identity; its key is descriptive, never authority. */
export type PluginUiTargetedContributionOperationV1 = {
    point: PluginUiTargetedContributionPointRefV1;
    contributor: PluginUiTargetedContributionContributorV1;
    role: string;
    action: PluginUiContributionIdentityV1;
};

/**
 * The exact current snapshot surface may be supplied directly to Plugin UI's
 * `TargetedSurface`; the mounted host rematches it before a child is rendered.
 */
export type PluginUiTargetedContributionSurfaceV1 = {
    point: PluginUiTargetedContributionPointRefV1;
    contributor: PluginUiTargetedContributionContributorV1;
    role: string;
    presentation: 'content' | 'fill';
};

export type PluginUiTargetedContributionV1 = {
    contributor: PluginUiTargetedContributionContributorV1;
    protocol: PluginUiTargetedContributionProtocolV1;
    descriptor?: PluginJsonValueV2;
    operations: PluginUiTargetedContributionOperationV1[];
    surfaces: PluginUiTargetedContributionSurfaceV1[];
};

export type PluginUiTargetedContributionProtocolSnapshotV1 = {
    protocol: PluginUiTargetedContributionProtocolV1;
    contributions: PluginUiTargetedContributionV1[];
};

export type PluginUiTargetedContributionPointSnapshotV1 = {
    pointId: string;
    protocols: PluginUiTargetedContributionProtocolSnapshotV1[];
};

/** The one target-filtered, immutable-generation admission snapshot for a mount. */
export type PluginUiTargetedContributionsV1 = {
    target: PluginUiTargetedContributionTargetV1;
    points: PluginUiTargetedContributionPointSnapshotV1[];
};

/**
 * Portable author declaration for the Protocol-owned strict rich context.
 * `clientTransport.ts` enforces mutual assignability with the canonical
 * Protocol type, while Protocol remains the sole runtime parser.
 */
export type PluginUiHostApiSurfaceContextV1 = {
    mount: PluginUiMountContextV1;
    target: PluginUiHostApiSurfaceTargetV1;
    accountEncryptionMode: 'plain' | 'e2ee';
    platform: PluginUiPlatform;
    locale: string;
    direction: 'ltr' | 'rtl';
    colorScheme: 'light' | 'dark';
    contrast: 'normal' | 'high';
    textScale: number;
    reducedMotion: boolean;
    screenReaderEnabled: boolean;
    safeAreaInsets: {
        top: number;
        right: number;
        bottom: number;
        left: number;
    };
    theme: PluginUiHostApiSurfaceThemeV1;
    translations: Record<string, string>;
    targetedContributions: PluginUiTargetedContributionsV1;
};

export type PluginUiResourceSubscriptionEventV1 =
    | {
        version: 1;
        subscriptionId: string;
        kind: 'invalidated';
        digest: string;
    }
    | {
        version: 1;
        subscriptionId: string;
        kind: 'complete';
        diagnostics: string[];
    }
    | {
        version: 1;
        subscriptionId: string;
        kind: 'error';
        code: 'unavailable' | 'denied' | 'stale_surface' | 'expired_resource';
        diagnostics: string[];
    };

export type OpenableContentRefV1 = {
    kind: 'workspaceFile';
    handle: string;
};

export type OpenableContentBodyV1 =
    | { kind: 'utf8'; text: string }
    | { kind: 'base64'; base64: string };

export type OpenableContentReadRequestInputV1 = {
    ref: OpenableContentRefV1;
    expectedRevision: string;
    maxBytes?: number;
};

export type OpenableContentStatResultV1 =
    | {
        status: 'ready';
        mimeType: string;
        contentClass: 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'binary';
        extension?: string;
        sizeBytes: number;
        revision: string;
    }
    | { status: 'unavailable' | 'unsupported' | 'cancelled' };

export type OpenableContentReadResultV1 =
    | { status: 'ready'; content: OpenableContentBodyV1; revision: string }
    | { status: 'tooLarge'; sizeBytes: number }
    | { status: 'unavailable' | 'changed' | 'unsupported' | 'cancelled' };

export type PluginUiTargetedContributionSelectionV1 = {
    target: PluginUiTargetedContributionTargetV1;
    point: PluginUiTargetedContributionPointRefV1;
    contributor: PluginUiTargetedContributionContributorV1;
};

export type PluginUiSelectActionInputTargetedRequestV1 = {
    operation: PluginUiTargetedContributionOperationV1;
    draft?: PluginUiJsonObjectV1;
};

export type PluginUiSelectActionInputHostRequestV1 = {
    hostAction: { action: 'session.spawn_new'; projection: 'serverStartDraft' };
    draft?: PluginUiJsonObjectV1;
};

/** The strict two-arm no-invoke selection request. */
export type PluginUiSelectActionInputRequestV1 =
    | PluginUiSelectActionInputTargetedRequestV1
    | PluginUiSelectActionInputHostRequestV1;

export type PluginUiSessionServerStartDraftV1 = Readonly<{
    executionTarget: unknown;
    directory: string;
    organizationPlacement?: unknown;
    agentTarget: unknown;
    modelSelection?: unknown;
    profileId?: string;
    permissionMode?: string;
    agentModeId?: string;
    configuration?: unknown;
    connectedServices?: unknown;
    mcpSelection?: unknown;
    transcriptStorage?: 'persisted' | 'direct';
    terminal?: unknown;
    checkoutCreationDraft?: unknown | null;
    title?: string;
    agentSessionStartupInstructionsV1?: unknown;
}>;

export type PluginUiSelectActionInputTargetedSubmittedV1 = {
    kind: 'submitted';
    action: PluginUiContributionIdentityV1;
    input: PluginUiJsonObjectV1;
    selection: PluginUiTargetedContributionSelectionV1;
    connectedAccount:
        | { kind: 'none' }
        | { kind: 'selected'; fieldPath: string; ref: QualifiedConnectedAccountRef };
};

/** Exact result arms: targeted submitted, no-invoke Session draft, or cancellation. */
export type PluginUiSelectActionInputResultV1 =
    | PluginUiSelectActionInputTargetedSubmittedV1
    | { kind: 'serverStartDraft'; draft: PluginUiSessionServerStartDraftV1 }
    | { kind: 'cancelled' };

/** Transient carrier whose currentness remains owned by the host. */
export type PluginUiSelectedActionInputCarrierV1 = {
    operation: PluginUiTargetedContributionOperationV1;
    result: PluginUiSelectActionInputTargetedSubmittedV1;
};

export type ComposerRefV1 = DeepReadonly<
    | { kind: 'session'; sessionId: string }
    | { kind: 'newSession'; instanceId: string }
    | { kind: 'pendingMessage'; sessionId: string; localId: string }
    | { kind: 'participantMessage'; sessionId: string; instanceId: string }
    | { kind: 'automationAuthoring'; sessionId: string; instanceId: string }
>;

/**
 * Closed host-stamped launch carrier for one Composer-mounted renderer.
 *
 * It stays distinct from ordinary `RenderContext.launchInput`: only the host
 * constructs this discriminated value for a Composer mount. Protocol remains
 * the sole parser and runtime-value owner.
 */
export type ComposerSurfaceInputV1 = DeepReadonly<
    | {
        v: 1;
        role: 'controlCompact' | 'controlInteraction';
        composer: ComposerRefV1;
        controlLocalId: string;
        state: {
            visible?: boolean;
            enabled?: boolean;
            label?: string;
            icon?: PluginUiIconTokenV1;
            count?: number;
            selected?: boolean;
            selectedChoiceIds?: string[];
            accessibilityLabel?: string;
            unavailableReason?: string;
        };
    }
    | {
        v: 1;
        role: 'attachmentPicker';
        composer: ComposerRefV1;
        attachmentLocalId: string;
        instances: ComposerAttachmentViewV1[];
    }
    | {
        v: 1;
        role: 'attachmentDisplay' | 'attachmentPreview';
        composer: ComposerRefV1;
        attachmentLocalId: string;
        instance: ComposerAttachmentViewV1;
    }
    | {
        v: 1;
        role: 'region';
        composer: ComposerRefV1;
        regionLocalId: string;
    }
>;

export type ComposerTextPositionV1 = DeepReadonly<{ offset: number }>;
export type ComposerTextRangeV1 = DeepReadonly<{ start: number; end: number }>;
export type ComposerReferenceSelectorV1 = DeepReadonly<{ ref: string; start: number; end: number }>;
export type ComposerMentionRefV1 = DeepReadonly<{
    kind: string;
    ref: string;
    token: string;
    start: number;
    end: number;
    label?: string;
    composerReference?: PluginUiContributionIdentityV1;
}>;
export type ComposerAttachmentPresentationV1 = DeepReadonly<{
    label: string;
    description?: string;
    icon?: PluginUiIconTokenV1;
    tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
    typeLabel: string;
}>;
export type ComposerAttachmentViewV1 = DeepReadonly<{
    v: 1;
    instanceId: string;
    attachment: PluginUiContributionIdentityV1;
    key: string;
    value: PluginJsonValueV2;
    presentation: ComposerAttachmentPresentationV1;
    availability:
        | { status: 'ready' }
        | { status: 'unavailable' | 'invalid'; reason?: string };
    content?: ComposerStagedMediaContentV1;
}>;
export type ComposerCapabilitiesV1 = DeepReadonly<{
    text: true;
    references: boolean;
    attachments: boolean;
    submit: boolean;
}>;
export type ComposerSnapshotV1 = DeepReadonly<{
    revision: number;
    ref: ComposerRefV1;
    text: string;
    selection?: ComposerTextRangeV1;
    references: ComposerMentionRefV1[];
    attachments: ComposerAttachmentViewV1[];
    layout: 'wrap' | 'scroll' | 'collapsed';
    capabilities: ComposerCapabilitiesV1;
    state: {
        focused: boolean;
        editable: boolean;
        submittable: boolean;
        submitting: boolean;
        running: boolean;
        inputLock?: { mode: 'submit' | 'editAndSubmit'; reasons: string[] };
    };
}>;
export type ComposerAttachmentAuthorPresentationV1 = DeepReadonly<{
    label: string;
    description?: string;
    icon?: PluginUiIconTokenV1;
    tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
}>;
export type ComposerAttachmentAuthorValueV1 = DeepReadonly<{
    key: string;
    value: PluginJsonValueV2;
    presentation: ComposerAttachmentAuthorPresentationV1;
}>;
export type ComposerAttachmentUpdateV1 = DeepReadonly<{
    value: PluginJsonValueV2;
    presentation?: ComposerAttachmentAuthorPresentationV1;
}>;
export type ComposerOperationV1 = DeepReadonly<
    | { kind: 'text.set'; text: string }
    | { kind: 'text.insert'; position: ComposerTextPositionV1; text: string }
    | { kind: 'text.replaceRange'; range: ComposerTextRangeV1; text: string }
    | { kind: 'text.clear' }
    | { kind: 'reference.insert'; reference: ComposerMentionRefV1 }
    | { kind: 'reference.remove'; reference: ComposerReferenceSelectorV1 }
    | {
        kind: 'attachment.add';
        attachmentLocalId: string;
        value: ComposerAttachmentAuthorValueV1;
        content?: ComposerStagedMediaContentV1;
    }
    | { kind: 'attachment.update'; instanceId: string; update: ComposerAttachmentUpdateV1 }
    | { kind: 'attachment.remove'; instanceId: string }
>;
export type ComposerTransactionV1 = DeepReadonly<{
    expectedRevision: number;
    operations: ComposerOperationV1[];
}>;
export type ComposerTransactionResultV1 = DeepReadonly<
    | { status: 'applied'; revision: number; attachmentInstanceIds?: string[] }
    | { status: 'conflict'; currentRevision: number }
    | { status: 'composerUnavailable' }
    | { status: 'notEditable' }
    | { status: 'invalidOperation'; operationIndex: number; reason: string; detail?: PluginJsonValueV2 }
    | { status: 'limitExceeded'; limit: string; maximum: number; actual: number }
>;
export type ComposerUnavailableReasonV1 = 'notFound' | 'scopeClosed' | 'staleGeneration';
export type ComposerReadResultV1 = DeepReadonly<
    | { status: 'ready'; snapshot: ComposerSnapshotV1 }
    | { status: 'unavailable'; reason: ComposerUnavailableReasonV1 }
>;
export type ComposerFocusResultV1 = DeepReadonly<
    | { status: 'focused' }
    | { status: 'notEditable' }
    | { status: 'unavailable'; reason: ComposerUnavailableReasonV1 }
>;
export type ComposerDecorationSetV1 = DeepReadonly<{
    revision: number;
    ranges: Array<{
        range: ComposerTextRangeV1;
        treatment:
            | 'highlight'
            | 'muted'
            | 'warning'
            | 'success'
            | 'code'
            | { kind: 'link'; url: string };
        label?: string;
    }>;
}>;
export type ComposerDecorationResultV1 = DeepReadonly<
    | { status: 'set' }
    | { status: 'cleared' }
    | { status: 'staleRevision'; currentRevision: number }
    | { status: 'invalid' }
    | { status: 'unavailable'; reason: ComposerUnavailableReasonV1 }
>;
export type ComposerInputLockRequestV1 = DeepReadonly<{
    reason: string;
    mode: 'submit' | 'editAndSubmit';
}>;

export type PluginUiHostApiWireIdentityV1 = {
    pluginId: string;
    pluginVersion: string;
    viewId: string;
    generation: string;
    sessionId?: string;
};

export type PluginUiTestkitMountAvailability = {
    state: 'available' | 'fallback' | 'blocked' | 'disabled';
    reason: string;
    diagnostics: string[];
};

export type PluginHostedWebBridgeEnvelopeV1 = {
    version: 1;
    pluginId: string;
    contributionId: string;
    surfaceId: string;
    sessionId?: string;
    nonce: string;
    sequence: number;
    kind: 'ready' | 'error' | 'heightChanged' | 'hostApi' | 'collectionUiQuery';
    payload: PluginUiJsonValueV1;
};

export type PluginHostedWebCollectionUiQueryBridgeOperationV1 =
    | {
        kind: 'open';
        collectionId: string;
        uiQueryId: string;
        parameters: Record<string, string | number | boolean>;
    }
    | { kind: 'page'; queryId: string }
    | { kind: 'close'; queryId: string };

export type PluginHostedWebCollectionUiQueryBridgeResponseV1 =
    | {
        kind: 'snapshot';
        queryId: string;
        snapshot: {
            status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
            rows: Array<{
                context: {
                    collection: { pluginId: string; collectionId: string };
                    rowId: string;
                    revision: number;
                };
                fields: Record<string, string | number | boolean | null>;
            }>;
            hasMore: boolean;
            error?: {
                error:
                    | 'collection_query_invalid'
                    | 'collection_cursor_invalid'
                    | 'collection_unavailable'
                    | 'collection_index_not_ready'
                    | 'collection_content_mode_mismatch'
                    | 'collection_contract_inconsistent';
            };
        };
    }
    | { kind: 'closed'; queryId: string };

export type PluginHostedWebCollectionUiQueryBridgeChangeV1 = {
    kind: 'change';
    queryId: string;
};

export type PluginHostedWebContributionV1 = {
    id: string;
    service:
        | { kind: 'staticAssets'; assetRootId: string }
        | { kind: 'sessionEndpoint'; endpointIdPath: string };
    entry: {
        path?: string;
        query?: Record<string, string>;
        routeMode: 'hostOrigin' | 'pathFallback';
    };
    bridge: {
        allowedMessages: Array<'ready' | 'error' | 'heightChanged' | 'hostApi' | 'collectionUiQuery'>;
    };
    display: {
        titleKey: string;
        descriptionKey?: string;
        labelKey?: string;
        iconToken?: PluginUiIconTokenV1;
        tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';
        developerFallback?: string;
    };
    sandbox: {
        scripts: boolean;
        sameOrigin: boolean;
        popups: boolean;
        topNavigation: boolean;
        mixedContent: boolean;
    };
    security: unknown;
    compatibility?: unknown;
    fallback: unknown;
};

export type PluginUiDeclarativeToneV2 = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export type PluginUiDeclarativeNodeV2 =
    | { kind: 'text'; text: PluginLocalizedStringV2; tone?: PluginUiDeclarativeToneV2 }
    | { kind: 'markdown'; text: PluginLocalizedStringV2 }
    | {
        kind: 'stack';
        direction?: 'vertical' | 'horizontal';
        gap?: 'small' | 'medium' | 'large';
        children: PluginUiDeclarativeNodeV2[];
    }
    | {
        kind: 'group';
        title?: PluginLocalizedStringV2;
        description?: PluginLocalizedStringV2;
        children: PluginUiDeclarativeNodeV2[];
    }
    | { kind: string; readonly [key: string]: unknown };

/** One settings destination declaration before host catalog projection. */
export type PluginUiSettingsPageV1 = {
    id: string;
    group:
        | { kind: 'host'; id: 'general' | 'aiAndAgents' | 'sessionsBehavior' | 'filesAndSourceControl' | 'system' }
        | { kind: 'plugin'; localId: string };
    title: PluginLocalizedStringV2;
    subtitle?: PluginLocalizedStringV2;
    keywords?: string[];
    icon?: PluginUiIconTokenV1;
    defaultRank?: number;
    renderer: string;
};

export type PluginDeclarativeDocumentContentTypeV1 =
    'application/vnd.happier.declarative-document+json;version=1';
export type PluginDeclarativeDocumentV1 = Readonly<{
    version: 1;
    root: PluginUiDeclarativeNodeV2;
}>;

export type PluginUiRendererV2 =
    | {
        id: string;
        kind: 'reactNative';
        artifact: string;
        requiredHostMethods?: PluginUiHostMethodV1[];
    }
    | {
        id: string;
        kind: 'hostedWeb';
        source: { kind: 'artifact'; artifact: string };
        requiredHostMethods?: PluginUiHostMethodV1[];
    }
    | {
        id: string;
        kind: 'declarative';
        root: PluginUiDeclarativeNodeV2;
        documentSource?: { kind: 'resource'; resourceId: string };
    };

export type PluginUiViewTargetV2 =
    | { kind: 'app' }
    | { kind: 'session'; sessionIdPath?: string }
    | {
        kind: 'project';
        workspaceRefIdPath?: string;
        serverIdPath?: string;
        machineIdPath?: string;
        rootPathPath?: string;
        projectIdPath?: string;
    }
    | {
        kind: 'browser';
        browserViewIdPath: string;
        sessionIdPath?: string;
        profileIdPath?: string;
    }
    | { kind: 'services'; sessionIdPath?: string; serverIdPath?: string; machineIdPath?: string };

export type PluginUiViewDestinationBindingInputV2 =
    | { container: 'appPage'; target: { kind: 'app' } }
    | { container: 'rightSidebarTab'; target: { kind: 'app' } | { kind: 'session'; sessionIdPath?: string } | PluginUiViewTargetV2 & { kind: 'project' } }
    | { container: 'rightPane' | 'detailsTab' | 'detailsPane' | 'bottomPane'; target: { kind: 'session'; sessionIdPath?: string } | PluginUiViewTargetV2 & { kind: 'project' } }
    | { container: 'browserPanel'; target: PluginUiViewTargetV2 & { kind: 'browser' } }
    | { container: 'servicesPanel'; target: PluginUiViewTargetV2 & { kind: 'services' } };

export type PluginUiPageHeaderActionV1 = {
    id: string;
    title: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    icon?: PluginUiIconTokenV1;
    order?: number;
    command: unknown;
};

export type PluginUiViewV2Input = PluginUiViewDestinationBindingInputV2 & {
    id: string;
    renderer: string;
    fallbackRenderers?: string[];
    title?: PluginLocalizedStringV2;
    icon?: PluginUiIconTokenV1;
    badge?: { label: PluginLocalizedStringV2; tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' };
    groupHint?: 'navigation' | 'sessions';
    rankHint?: number;
    instancePolicy?: 'singleton' | 'multiple';
    headerActions?: PluginUiPageHeaderActionV1[];
};

export type PluginUiViewV2 = PluginUiViewV2Input & {
    instancePolicy: 'singleton' | 'multiple';
    headerActions: PluginUiPageHeaderActionV1[];
};

export type PluginUiTranslationBundleV2 = {
    locale: string;
    messages: Record<string, string>;
};

export type PluginSessionHeaderActionDescriptor = {
    id: string;
    title: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    icon?: PluginUiIconTokenV1;
    order?: number;
    command: unknown;
    availability?: unknown;
};

/** One verified file in an author-generated UI artifact tree. */
export type PluginUiArtifactFileV1 = {
    relativePath: string;
    digest: `sha256:${string}`;
    byteSize: number;
};

export type PluginUiArtifactsManifestEntryV1 = {
    contributionId: string;
    tier: 'hostedWeb' | 'reactNative';
    platform?: PluginUiPlatform;
    entry: string;
    files: PluginUiArtifactFileV1[];
    digest: `sha256:${string}`;
    builtWith: { bundler: 'vite' | 'repack'; version: string };
    repack?: { containerName: string; modulePath: string; exportName: string };
    /** Signed host-private candidate Collection migration module identity. */
    collectionMigrations?:
        | { containerName: string; modulePath: string; exportName: string }
        | { exportName: string };
    hostUiApiVersion: string;
    compat: {
        react?: string;
        reactNative?: string;
        expoRuntime?: string;
        hermes?: string;
    };
};

export type PluginUiHostNativeRuntimeExternalSpecifierV1 =
    | 'react'
    | 'react/jsx-runtime'
    | 'react/jsx-dev-runtime'
    | 'react-native'
    | 'react-native-reanimated'
    | '@react-navigation/native'
    | '@react-navigation/native-stack';

export type PluginUiHostRuntimeExternalSpecifierV1 =
    | 'react'
    | 'react/jsx-runtime'
    | 'react/jsx-dev-runtime'
    | 'react-native-web'
    | '@happier-dev/plugin-sdk/ui/client';

export type PublicToolchainAuthoringDependencyV1 = {
    packageName: string;
    dependencySpec: string;
    resolvedVersion: string;
};

/** The release-owned public author-toolchain packet, structurally projected for SDK declarations. */
export type PublicToolchainCompatibilityV1 = {
    schemaVersion: 1;
    host: { buildIdentity: string; enginesHappier?: string };
    pluginSdk: { version: string };
    pluginUi: { version: string; pluginSdkVersion: string };
    framework: {
        react: string;
        reactNative: string;
        reactNativeWeb: string;
        vite: string;
        repack: string;
        expo: string;
        runtime: string;
    };
    ui: { artifactGrammarVersion: number; hostApiVersion: string };
    authoringDependencies: {
        nodeTypes: PublicToolchainAuthoringDependencyV1;
        reactDom: PublicToolchainAuthoringDependencyV1;
        reactTypes: PublicToolchainAuthoringDependencyV1;
        reactNativeCommunityCli: PublicToolchainAuthoringDependencyV1;
        rspack: PublicToolchainAuthoringDependencyV1;
        swcHelpers: PublicToolchainAuthoringDependencyV1;
        typescriptNative: PublicToolchainAuthoringDependencyV1;
        viteReactPlugin: PublicToolchainAuthoringDependencyV1;
    };
    buildTools: Array<{
        packageName: string;
        packageVersion: string;
        executable: string;
        executableVersion: string;
    }>;
};
