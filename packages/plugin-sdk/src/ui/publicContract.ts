import type { PluginUiToneV1 as DtoPluginUiToneV1, PluginUiAttachmentToneV1 as DtoPluginUiAttachmentToneV1, PluginUiIconTokenV1 as DtoPluginUiIconTokenV1 } from '../actions/dtos/actionDeclarativeNodeDto.generated.js';
import type { QualifiedConnectedAccountRef } from '../connectedAccounts.js';
import type { ProjectKeyV1, SessionServerStartSpawnDraftV1 } from '../services/sessions.js';
import type { JsonValue } from '../identity.js';
import type { PluginActionInputById } from '../actions/actionTypeMap.generated.js';
import type { WorkBoardPreviewLayoutV1 as ProtocolWorkBoardPreviewLayoutV1 } from '@happier-dev/protocol';
import type {
    StoredImageRefV1 as ProtocolStoredImageRefV1,
    PluginUiReadStoredImageResultV1 as ProtocolPluginUiReadStoredImageResultV1,
} from '@happier-dev/protocol/plugins/ui/client';
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
    ComposerDecorationResultV1 as ProtocolComposerDecorationResultV1,
    ComposerDecorationSetV1 as ProtocolComposerDecorationSetV1,
    ComposerFocusResultV1 as ProtocolComposerFocusResultV1,
    ComposerInputLockRequestV1 as ProtocolComposerInputLockRequestV1,
    ComposerOperationV1 as ProtocolComposerOperationV1,
    ComposerReadResultV1 as ProtocolComposerReadResultV1,
    ComposerRefV1 as ProtocolComposerRefV1,
    ComposerSnapshotV1 as ProtocolComposerSnapshotV1,
    ComposerSurfaceInputV1 as ProtocolComposerSurfaceInputV1,
    ComposerTransactionResultV1 as ProtocolComposerTransactionResultV1,
    ComposerTransactionV1 as ProtocolComposerTransactionV1,
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
    PluginUiSessionStateV1 as ProtocolPluginUiSessionStateV1,
    PluginUiSessionPendingPermissionV1 as ProtocolPluginUiSessionPendingPermissionV1,
    PluginUiSessionPermissionAnswerV1 as ProtocolPluginUiSessionPermissionAnswerV1,
    PluginUiRespondToSessionPermissionRequestV1 as ProtocolPluginUiRespondToSessionPermissionRequestV1,
    PluginUiRespondToSessionPermissionResultV1 as ProtocolPluginUiRespondToSessionPermissionResultV1,
    PluginUiPreparedReviewWorkspaceResultV1 as ProtocolPluginUiPreparedReviewWorkspaceResultV1,
    PluginHostedWebAccountDataBridgeOperationV1 as ProtocolPluginHostedWebAccountDataBridgeOperationV1,
    PluginHostedWebAccountDataBridgeResponseV1 as ProtocolPluginHostedWebAccountDataBridgeResponseV1,
    PluginHostedWebAccountDataBridgeChangeV1 as ProtocolPluginHostedWebAccountDataBridgeChangeV1,
} from '@happier-dev/protocol/plugins/ui/client';
import type {
    PluginUiAppPageColumnV1 as ProtocolPluginUiAppPageColumnV1,
    PluginUiWidgetAreaDeclarationV1 as ProtocolPluginUiWidgetAreaDeclarationV1,
    PluginUiDestinationPlacementV1 as ProtocolPluginUiDestinationPlacementV1,
    PluginUiViewInlineBindingInputV2 as ProtocolPluginUiViewInlineBindingInputV2,
    PluginUiContainerV1 as ProtocolPluginUiContainerV1,
    PluginUiDestinationContainerV1 as ProtocolPluginUiDestinationContainerV1,
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
/** Declaration-only image projections; Protocol owns the request and disclosure grammar. */
export type StoredImageRefV1 = ProtocolStoredImageRefV1;
export type PluginUiReadStoredImageResultV1 = ProtocolPluginUiReadStoredImageResultV1;
/** Saved Board structure only; Protocol retains the sole strict parser and producer. */
export type WorkBoardPreviewLayoutV1 = ProtocolWorkBoardPreviewLayoutV1;

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
export type PluginUiToneV1 = DtoPluginUiToneV1;

/** The one canonical narrowing: Composer attachment presentation excludes `accent`. */
export type PluginUiAttachmentToneV1 = DtoPluginUiAttachmentToneV1;

export type PluginUiIconTokenV1 = DtoPluginUiIconTokenV1;

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

export type PluginUiContainerV1 = ProtocolPluginUiContainerV1;
export type PluginUiDestinationContainerV1 = ProtocolPluginUiDestinationContainerV1;

export type PluginUiMountContextV1 =
    | Readonly<{
        kind: 'destination';
        destination: PluginUiContributionIdentityV1;
        container: PluginUiDestinationContainerV1;
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
        attention: string;
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
        reading: PluginUiHostApiSurfaceTypographyMetricV1;
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
    /** Host page chrome for app pages; absent on other surface placements. */
    page?: { columnVisible: boolean };
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

export type PluginUiSelectActionInputHostRequestV1 =
    | {
        hostAction: { action: 'session.spawn_new'; projection: 'serverStartDraft' };
        draft?: PluginUiJsonObjectV1;
    }
    | {
        hostAction: { action: 'review.start'; projection: 'executionRunLaunch' };
        sessionId: string;
        serverId?: string;
        draft: { engineIds: string[]; instructions: string };
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
    /** Host-resolved, non-secret labels for confirmation UI. IDs are never substituted. */
    presentation: {
        connectedAccountLabel: string | null;
        machineDisplayName: string | null;
    };
};

/** Exact result arms: targeted submitted, host-owned no-invoke inputs, or cancellation. */
export type PluginUiSelectActionInputResultV1 =
    | PluginUiSelectActionInputTargetedSubmittedV1
    | { kind: 'serverStartDraft'; draft: PluginUiSessionServerStartDraftV1 }
    | {
        kind: 'executionRunLaunch';
        input: Pick<
            PluginActionInputById['execution.run.start'],
            'secretReferenceOverlay' | 'teamCredentialModel' | 'teamCredentialSessionBindingConsent'
        >;
    }
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

/** Protocol owns the complete browser-safe Composer grammar; SDK only names author aliases. */
export type ComposerRefV1 = ProtocolComposerRefV1;

/**
 * Closed host-stamped launch carrier for one Composer-mounted renderer.
 *
 * It stays distinct from ordinary `RenderContext.launchInput`: only the host
 * constructs this discriminated value for a Composer mount. Protocol remains
 * the sole parser and runtime-value owner.
 */
export type ComposerSurfaceInputV1 = ProtocolComposerSurfaceInputV1;
export type ComposerSnapshotV1 = ProtocolComposerSnapshotV1;
export type ComposerOperationV1 = ProtocolComposerOperationV1;
export type ComposerTransactionV1 = ProtocolComposerTransactionV1;
export type ComposerTransactionResultV1 = ProtocolComposerTransactionResultV1;
export type ComposerReadResultV1 = ProtocolComposerReadResultV1;
export type ComposerFocusResultV1 = ProtocolComposerFocusResultV1;
export type ComposerDecorationSetV1 = ProtocolComposerDecorationSetV1;
export type ComposerDecorationResultV1 = ProtocolComposerDecorationResultV1;
export type ComposerInputLockRequestV1 = ProtocolComposerInputLockRequestV1;

/** Leaf names derive from those same owner types, so nested fields cannot drift. */
export type ComposerTextPositionV1 = Extract<
    ProtocolComposerOperationV1,
    { kind: 'text.insert' }
>['position'];
export type ComposerTextRangeV1 = NonNullable<ProtocolComposerSnapshotV1['selection']>;
export type ComposerReferenceSelectorV1 = Extract<
    ProtocolComposerOperationV1,
    { kind: 'reference.remove' }
>['reference'];
export type ComposerMentionRefV1 = ProtocolComposerSnapshotV1['references'][number];
export type ComposerAttachmentViewV1 = ProtocolComposerSnapshotV1['attachments'][number];
export type ComposerAttachmentPresentationV1 = ComposerAttachmentViewV1['presentation'];
export type ComposerCapabilitiesV1 = ProtocolComposerSnapshotV1['capabilities'];
export type ComposerAttachmentAuthorValueV1 = Extract<
    ProtocolComposerOperationV1,
    { kind: 'attachment.add' }
>['value'];
export type ComposerAttachmentAuthorPresentationV1 = ComposerAttachmentAuthorValueV1['presentation'];
export type ComposerAttachmentUpdateV1 = Extract<
    ProtocolComposerOperationV1,
    { kind: 'attachment.update' }
>['update'];
export type ComposerUnavailableReasonV1 = Extract<
    ProtocolComposerReadResultV1,
    { status: 'unavailable' }
>['reason'];

/**
 * Linked-Session state for plugin UI (r0.42). Protocol owns the closed grammar;
 * lifecycle, runtime and operational state are the canonical Session awareness
 * projection's own vocabulary. `workStatus` is the host's shared Work
 * presentation, including report-aware settlement, not a plugin derivation.
 */
export type SessionStateV1 = ProtocolPluginUiSessionStateV1;
export type SessionPendingPermissionV1 = ProtocolPluginUiSessionPendingPermissionV1;
export type SessionPermissionAnswerV1 = ProtocolPluginUiSessionPermissionAnswerV1;
export type SessionPermissionResponseRequestV1 = ProtocolPluginUiRespondToSessionPermissionRequestV1;
export type SessionPermissionResponseV1 = ProtocolPluginUiRespondToSessionPermissionResultV1;

export type PluginUiHostApiWireIdentityV1 = {
    instanceId: string;
    mountNonce: string;
};

export type PluginUiTestkitMountAvailability = {
    state: 'available' | 'fallback' | 'blocked' | 'disabled';
    reason: string;
    diagnostics: string[];
};

export type PluginHostedWebBridgeEnvelopeV1 = {
    version: 1;
    identity: PluginUiHostApiWireIdentityV1;
    sequence: number;
    kind: 'ready' | 'error' | 'heightChanged' | 'hostApi' | 'openExternal' | 'accountData';
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
        kind: 'hostedHtml';
        source: { kind: 'html'; html: string };
        requiredHostMethods?: PluginUiHostMethodV1[];
        /**
         * The reach a self-contained document asks for beyond its host methods.
         * Requesting is not receiving: the host still admits each Resource and
         * Action, and egress is limited to these exact approved HTTPS origins.
         */
        requestedCapabilities?: {
            resources?: { pluginId: string; localId: string }[];
            actions?: (string | { pluginId: string; localId: string })[];
            networkOrigins?: string[];
        };
    }
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

export type PluginUiDestinationPlacementV1 = ProtocolPluginUiDestinationPlacementV1;
export type PluginUiAppPageColumnV1 = ProtocolPluginUiAppPageColumnV1;

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
        placement?: PluginUiDestinationPlacementV1;
        column?: PluginUiAppPageColumnV1;
        widgetAreas?: PluginUiWidgetAreaDeclarationV1[];
    }
    | {
        container: 'rightSidebarTab';
        target: { kind: 'app' };
        instancePolicy?: 'singleton';
        headerActions?: [];
        placement?: PluginUiDestinationPlacementV1;
    }
    | {
        container: 'rightSidebarTab';
        target: { kind: 'session'; sessionIdPath?: string } | PluginUiViewTargetV2 & { kind: 'project' };
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

export type PluginUiWidgetAreaDeclarationV1 = ProtocolPluginUiWidgetAreaDeclarationV1;

/**
 * Inline host roles share a renderer declaration. Widgets inherit the canonical
 * neutral inputs and exact Session input path; their target describes execution,
 * while each configured instance may be hosted on any WidgetSurface.
 */
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
        expo: string;
        runtime: string;
    };
    ui: { artifactGrammarVersion: number; hostApiVersion: string };
    authoringDependencies: {
        nodeTypes: PublicToolchainAuthoringDependencyV1;
        reactDom: PublicToolchainAuthoringDependencyV1;
        reactTypes: PublicToolchainAuthoringDependencyV1;
        typescript: PublicToolchainAuthoringDependencyV1;
        typescriptNative: PublicToolchainAuthoringDependencyV1;
    };
};
/** Opaque source selection; the mounted host supplies transport and caller authority. */
export type PluginLiveStreamReferenceV1 =
    | Readonly<{ kind: 'plugin'; source: Readonly<{ pluginId: string; localId: string }> }>
    | Readonly<{ kind: 'host'; sourceId: string }>;
