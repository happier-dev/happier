import type { QualifiedConnectedAccountRef } from '../connectedAccounts.js';
import type { ProjectKeyV1, SessionServerStartSpawnDraftV1 } from '../services/sessions.js';
import type { ComposerStagedMediaContentV1 } from '../composer.js';
import type { JsonValue, PluginJsonValueV2 } from '../identity.js';
import type { PluginAvailabilityDescriptor } from '../manifest.js';
import type {
    PluginDeclarativeNodeV2 as PluginManifestDeclarativeNodeV2,
    PluginDeclarativeToneV2 as PluginManifestDeclarativeToneV2,
    PluginLocalizedStringV2,
} from '../manifest.js';
import type {
    CurrentUiCommandDeclarationV1 as ProtocolCurrentUiCommandDeclarationV1,
    CurrentUiCommandDescriptorV1 as ProtocolCurrentUiCommandDescriptorV1,
    CurrentUiContextBoundedIncompletenessV1 as ProtocolCurrentUiContextBoundedIncompletenessV1,
    CurrentUiContextEntityV1 as ProtocolCurrentUiContextEntityV1,
    CurrentUiContextSnapshotV1 as ProtocolCurrentUiContextSnapshotV1,
    ComposerControlStateContentTypeV1 as ProtocolComposerControlStateContentTypeV1,
    ComposerControlStateV1 as ProtocolComposerControlStateV1,
    PluginUiContextEnrichmentV1 as ProtocolPluginUiContextEnrichmentV1,
    PluginTargetedContributionSelectionV1 as ProtocolPluginUiTargetedContributionSelectionV1,
    PluginUiTargetedContributionOperationV1 as ProtocolPluginUiTargetedContributionOperationV1,
    PluginUiTargetedContributionPointRefV1 as ProtocolPluginUiTargetedContributionPointRefV1,
    PluginUiTargetedContributionPointSnapshotV1 as ProtocolPluginUiTargetedContributionPointSnapshotV1,
    PluginUiTargetedContributionProtocolSnapshotV1 as ProtocolPluginUiTargetedContributionProtocolSnapshotV1,
    PluginUiTargetedContributionProtocolV1 as ProtocolPluginUiTargetedContributionProtocolV1,
    PluginUiTargetedContributionSelectorV1 as ProtocolPluginUiTargetedContributionSelectorV1,
    PluginUiTargetedContributionSurfaceV1 as ProtocolPluginUiTargetedContributionSurfaceV1,
    PluginUiTargetedContributionV1 as ProtocolPluginUiTargetedContributionV1,
    PluginUiTargetedContributionsV1 as ProtocolPluginUiTargetedContributionsV1,
    PluginUiHostMethodV1 as ProtocolPluginUiHostMethodV1,
    PluginUiPreparedReviewWorkspaceResultV1 as ProtocolPluginUiPreparedReviewWorkspaceResultV1,
    PluginHostedWebAccountDataBridgeOperationV1 as ProtocolPluginHostedWebAccountDataBridgeOperationV1,
    PluginHostedWebAccountDataBridgeResponseV1 as ProtocolPluginHostedWebAccountDataBridgeResponseV1,
    PluginHostedWebAccountDataBridgeChangeV1 as ProtocolPluginHostedWebAccountDataBridgeChangeV1,
} from '@happier-dev/protocol/plugins/ui/client';
import type {
    PluginUiViewInlineBindingInputV2 as ProtocolPluginUiViewInlineBindingInputV2,
} from '@happier-dev/protocol/plugins/contributions/ui';

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
    ComposerContentInspectWireResultV1,
    ComposerContentMediaKindV1,
    ComposerContentMimeTypeV1,
    ComposerContentPickMediaRequestV1,
    ComposerMediaContentCapabilityV1,
    ComposerSessionMediaContentV1,
    ComposerStagedMediaContentV1,
} from '../composer.js';
export type ComposerControlStateContentTypeV1 = ProtocolComposerControlStateContentTypeV1;
export type ComposerControlStateV1 = ProtocolComposerControlStateV1;

/**
 * Declaration-only projections for public UI author contracts.
 *
 * Protocol remains the sole parser, normalizer, and runtime-value owner. SDK
 * retains declaration-only projections where it owns the public surface, and
 * aliases Protocol DTOs instead of copying their strict grammar.
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

/**
 * The one plugin-UI tone vocabulary, named once for every public field that
 * carries it.
 *
 * It was previously restated inline at four call sites, and one of them
 * diverged: the view badge omitted `accent` while the canonical
 * `PluginUiDestinationBadgeV1Schema` admits it, so an author could not express
 * a value the host parses. `PluginUiAttachmentToneV1` is the single canonical
 * narrowing (`PluginUiToneV1Schema.exclude(['accent'])`) derived from this name
 * rather than typed out a second time. Like `PluginUiIconTokenV1`, the members
 * are written here so an author's `.d.ts` stays portable; `uiPublicContract.test.ts`
 * asserts both against Protocol's owner so neither can drift again.
 */
export type PluginUiToneV1 =
    | 'neutral'
    | 'info'
    | 'success'
    | 'warning'
    | 'danger'
    | 'accent';

/** The one canonical narrowing: Composer attachment presentation excludes `accent`. */
export type PluginUiAttachmentToneV1 = Exclude<PluginUiToneV1, 'accent'>;

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
    | 'search'
    | 'change-open'
    | 'change-complete';

/** Protocol's sole producer-backed Host API vocabulary; never copied here. */
export type PluginUiHostMethodV1 = ProtocolPluginUiHostMethodV1;

export type PluginUiContributionIdentityV1 = Readonly<{
    pluginId: string;
    localId: string;
}>;

/** Protocol owns this grammar and its strict parser; SDK exposes only type aliases. */
export type CurrentUiContextEntityV1 = ProtocolCurrentUiContextEntityV1;
export type CurrentUiCommandDeclarationV1 = ProtocolCurrentUiCommandDeclarationV1;
export type CurrentUiCommandDescriptorV1 = ProtocolCurrentUiCommandDescriptorV1;
export type CurrentUiContextBoundedIncompletenessV1 = ProtocolCurrentUiContextBoundedIncompletenessV1;
export type PluginUiContextEnrichmentV1 = ProtocolPluginUiContextEnrichmentV1;
export type CurrentUiContextSnapshotV1 = ProtocolCurrentUiContextSnapshotV1;
export type PluginUiSemanticCommandV1 = CurrentUiCommandDeclarationV1['command'];
export type PluginUiSemanticExecuteActionCommandV1 = Extract<
    PluginUiSemanticCommandV1,
    { kind: 'executeAction' }
>;
export type PluginUiSemanticOpenSurfaceCommandV1 = Extract<
    PluginUiSemanticCommandV1,
    { kind: 'openSurface' }
>;

export type PluginUiContainerV1 =
    | 'appPage'
    | 'settingsPage'
    | 'rightSidebarTab'
    | 'rightPane'
    | 'detailsTab'
    | 'detailsPane'
    | 'bottomPane'
    | 'browserPanel'
    | 'servicesPanel'
    | 'sessionSubagentLaunch'
    | 'sessionSubagentDetails'
    | 'sessionInfoSection';

export type PluginUiMountContextV1 =
    | Readonly<{
        kind: 'destination';
        destination: PluginUiContributionIdentityV1;
        container: Exclude<
            PluginUiContainerV1,
            | 'sessionSubagentLaunch'
            | 'sessionSubagentDetails'
            | 'sessionInfoSection'
        >;
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

/** Protocol owns the targeted-contribution grammar; SDK only names its author-facing aliases. */
export type PluginUiTargetedContributionProtocolV1 = ProtocolPluginUiTargetedContributionProtocolV1;
export type PluginUiTargetedContributionPointRefV1 = ProtocolPluginUiTargetedContributionPointRefV1;
export type PluginUiTargetedContributionTargetV1 = ProtocolPluginUiTargetedContributionsV1['target'];
export type PluginUiTargetedContributionContributorV1 = ProtocolPluginUiTargetedContributionV1['contributor'];
export type PluginUiTargetedContributionOperationV1 = ProtocolPluginUiTargetedContributionOperationV1;
export type PluginUiTargetedContributionSurfaceV1 = ProtocolPluginUiTargetedContributionSurfaceV1;
export type PluginUiTargetedContributionV1 = ProtocolPluginUiTargetedContributionV1;
export type PluginUiTargetedContributionProtocolSnapshotV1 = ProtocolPluginUiTargetedContributionProtocolSnapshotV1;
export type PluginUiTargetedContributionPointSnapshotV1 = ProtocolPluginUiTargetedContributionPointSnapshotV1;
export type PluginUiTargetedContributionsV1 = ProtocolPluginUiTargetedContributionsV1;
export type PluginUiTargetedContributionSelectorV1 = ProtocolPluginUiTargetedContributionSelectorV1;

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

export type PluginUiTargetedContributionSelectionV1 = ProtocolPluginUiTargetedContributionSelectionV1;

export type PluginUiSelectActionInputTargetedRequestV1 = {
    operation: PluginUiTargetedContributionOperationV1;
    draft?: PluginUiJsonObjectV1;
};

export type PluginUiSelectActionInputHostRequestV1 = {
    hostAction: { action: 'session.spawn_new'; projection: 'serverStartDraft' };
    draft?: PluginUiJsonObjectV1;
};

/**
 * What the host writes into its own New Session screen before opening it.
 *
 * Every member is optional and an ABSENT member means "not seeded", never
 * "seeded empty" — a caller carrying only a prompt does not clear a directory
 * the reader already chose.
 */
export type PluginUiNewSessionSeedV1 = {
    prompt?: string;
    profileId?: string;
    /**
     * The resolved checkout question. It carries no worktree identity: the
     * host's New Session screen still owns the actual worktree selection and
     * any persisted checkout draft.
     */
    checkoutIntent?: PluginUiSessionCheckoutIntentV1;
    placement?:
        | { kind: 'exactTarget'; serverId: string; machineId: string; directory?: string }
        | { kind: 'currentTarget'; directory: string };
    /**
     * Exact placement candidates in the same grammar as the existing
     * `serverStartDraft` projection. This is deliberately not a singular
     * placement: callers with an ambiguous repository join cannot turn the
     * first candidate into an unattended launch.
     *
     * Readonly by contract: a seed is a caller-authored request, so a plugin
     * hands over its own frozen candidate answers and keeps array ownership.
     */
    candidates?: readonly PluginUiSessionPlacementCandidateV1[];
    /**
     * Composer attachments, as the AUTHOR half only — the same
     * `{ attachmentLocalId, value }` a live `attachment.add` carries. The host
     * qualifies the identity, resolves the type label and mints the instance id
     * when its New Session composer mounts, so a seed never holds an attachment
     * record and never becomes a second attachment owner.
     *
     * Readonly by contract: callers build these from their own readonly
     * delivery plans and must not need a defensive array copy to seed the
     * host's New Session screen.
     */
    attachments?: readonly { attachmentLocalId: string; value: ComposerAttachmentAuthorValueV1 }[];
};

/** Input for the dedicated, navigation-owning `openNewSession` Host method. */
export type PluginUiOpenNewSessionRequestV1 = PluginUiNewSessionSeedV1;
export type PluginUiPreparedReviewWorkspaceResultV1 =
    DeepReadonly<ProtocolPluginUiPreparedReviewWorkspaceResultV1>;

/** The canonical host checkout-question vocabulary projected for UI authors. */
export type PluginUiSessionCheckoutIntentV1 =
    | 'none'
    | 'preparedReviewWorkspace'
    | 'reuseWorkspace'
    | 'createWorktree'
    | 'ask';

export type PluginUiSessionPlacementCandidateV1 = {
    projectKey: ProjectKeyV1;
    serverId: string;
    machineId: string;
    rootPath: string;
    label?: string;
    reachable: boolean;
    worktrees: Array<{
        path: string;
        branch: string | null;
        isMain: boolean;
        isCurrent: boolean;
    }>;
};

/** The strict two-arm no-invoke selection request. */
export type PluginUiSelectActionInputRequestV1 =
    | PluginUiSelectActionInputTargetedRequestV1
    | PluginUiSelectActionInputHostRequestV1;

/**
 * The no-invoke Session settlement carries exactly the canonical browser-safe
 * server-start draft. `services/sessions.ts` already projects that draft for
 * the author boundary, so this is an alias of that owner rather than a second
 * hand-maintained copy: the predecessor copy had drifted (it never gained
 * `sourceContext`) and typed most of the draft as `unknown`.
 */
export type PluginUiSessionServerStartDraftV1 = SessionServerStartSpawnDraftV1;

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

/** Mount-scoped, non-durable input completion exposed only when the host installs it. */
export type PluginUiEphemeralInputSettlementV1 =
    | { kind: 'completed'; input: PluginUiJsonValueV1 }
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
    tone?: PluginUiAttachmentToneV1;
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
    tone?: PluginUiAttachmentToneV1;
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
    kind: 'ready' | 'error' | 'heightChanged' | 'hostApi' | 'accountData';
    payload: PluginUiJsonValueV1;
};

/**
 * The Protocol Data bridge grammar is the sole request/result authority. The
 * SDK only re-exports its exact structural types for authors; it does not
 * maintain a looser parallel JSON-value union.
 */
export type PluginHostedWebAccountDataBridgeOperationV1 = ProtocolPluginHostedWebAccountDataBridgeOperationV1;
export type PluginHostedWebAccountDataBridgeResponseV1 = ProtocolPluginHostedWebAccountDataBridgeResponseV1;
export type PluginHostedWebAccountDataBridgeChangeV1 = ProtocolPluginHostedWebAccountDataBridgeChangeV1;

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
        allowedMessages: Array<'ready' | 'error' | 'heightChanged' | 'hostApi' | 'accountData'>;
    };
    display: {
        titleKey: string;
        descriptionKey?: string;
        labelKey?: string;
        iconToken?: PluginUiIconTokenV1;
        tone?: PluginUiToneV1;
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

/**
 * UI authoring names the same closed grammar Protocol parses. These aliases
 * deliberately add no UI-local tone vocabulary or catch-all node member.
 */
export type PluginUiDeclarativeToneV2 = PluginManifestDeclarativeToneV2;
export type PluginUiDeclarativeNodeV2 = PluginManifestDeclarativeNodeV2;

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

/**
 * The representable destination grammar, correlated exactly as the canonical
 * Registry correlates it. Container, target, instance policy and page header
 * actions travel together on one arm so an author's editor rejects the same
 * declaration the host parser and the published JSON Schema reject. A flat
 * shape here let an editor accept `headerActions` on a pane and `multiple` on
 * a right-sidebar tab, both of which the host refuses at install time.
 */
export type PluginUiViewDestinationBindingInputV2 =
    | {
        container: 'appPage';
        target: { kind: 'app' };
        instancePolicy?: 'singleton';
        headerActions?: PluginUiPageHeaderActionV1[];
    }
    | {
        container: 'rightSidebarTab';
        target: { kind: 'app' } | { kind: 'session'; sessionIdPath?: string } | PluginUiViewTargetV2 & { kind: 'project' };
        instancePolicy?: 'singleton';
        headerActions?: [];
    }
    | {
        container: 'rightPane' | 'detailsTab' | 'detailsPane' | 'bottomPane';
        target: { kind: 'session'; sessionIdPath?: string } | PluginUiViewTargetV2 & { kind: 'project' };
        instancePolicy?: 'singleton' | 'multiple';
        headerActions?: [];
    }
    | {
        container: 'browserPanel';
        target: PluginUiViewTargetV2 & { kind: 'browser' };
        instancePolicy?: 'singleton';
        headerActions?: [];
    }
    | {
        container: 'servicesPanel';
        target: PluginUiViewTargetV2 & { kind: 'services' };
        instancePolicy?: 'singleton';
        headerActions?: [];
    };

/** Inline host roles share a renderer declaration, never destination chrome. */
export type PluginUiViewInlineBindingInputV2 = ProtocolPluginUiViewInlineBindingInputV2;

export type PluginUiPageHeaderActionV1 = {
    id: string;
    title: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    icon?: PluginUiIconTokenV1;
    order?: number;
    /** A same-plugin Action local id, or one explicit semantic command. */
    command: string | PluginUiSemanticCommandV1;
};

export type PluginUiViewV2Input = {
    id: string;
    renderer: string;
    fallbackRenderers?: string[];
    title?: PluginLocalizedStringV2;
    icon?: PluginUiIconTokenV1;
} & (
    | (PluginUiViewDestinationBindingInputV2 & {
        badge?: { label: PluginLocalizedStringV2; tone?: PluginUiToneV1 };
        groupHint?: 'navigation' | 'sessions';
        rankHint?: number;
    })
    | PluginUiViewInlineBindingInputV2
);

/**
 * The parsed view: the host resolves `instancePolicy` and `headerActions`
 * defaults, so both are present — still on their own correlated arm.
 */
export type PluginUiViewV2 = PluginUiViewV2Input extends infer TInput
    ? TInput extends PluginUiViewDestinationBindingInputV2
        ? TInput & Required<Pick<TInput, 'instancePolicy' | 'headerActions'>>
        : TInput
    : never;

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
    /** A same-plugin Action local id, or one explicit semantic command. */
    command: string | PluginUiSemanticCommandV1;
    availability?: PluginAvailabilityDescriptor;
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
        typescript: PublicToolchainAuthoringDependencyV1;
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
