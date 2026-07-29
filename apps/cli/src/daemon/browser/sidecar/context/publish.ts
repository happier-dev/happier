import {
    BrowserContextItemV1Schema,
    type BrowserContextAttachmentV1,
    type BrowserContextItemV1,
    type BrowserContextLifecycleStateV1,
} from '@happier-dev/protocol';

import {
    buildSidecarContextAttachment,
    buildSidecarContextUnavailableItem,
    buildSidecarPageReferenceContextItem,
    buildSidecarScreenshotContextItem,
    type SidecarPageReferenceContextInput,
    type SidecarScreenshotContextInput,
    type SidecarSummaryContextKind,
} from './capture';

type SidecarContextAccessInput = Readonly<{
    requesterAccountId: string;
}>;

type SidecarContextGateInput = Readonly<{
    featureEnabled: boolean;
    policyAllowed: boolean;
    runtimeAvailable: boolean;
}>;

type SidecarContextUnavailableLifecycleState = Extract<
    BrowserContextLifecycleStateV1,
    'adapterUnavailable' | 'captureFailed' | 'policyDenied' | 'sensitiveOrigin'
>;

type SidecarContextPublisherDeps = Readonly<{
    ownerAccountId: string;
    publish: (item: BrowserContextItemV1) => void;
}>;

type SidecarContextDeniedResult = Readonly<{
    status: 'denied';
    reason: 'not_owner';
    published: false;
}>;

type SidecarContextPublishedResult = Readonly<{
    status: 'published';
    published: true;
    item: BrowserContextItemV1;
    lifecycleState: BrowserContextLifecycleStateV1;
}>;

type SidecarContextBlockedResult = Readonly<{
    status: 'blocked';
    reason: 'policy_denied' | 'adapter_unavailable';
    published: false;
    lifecycleState: BrowserContextLifecycleStateV1;
    disabledReason: string;
}>;

export type SidecarContextPublicationResult =
    | SidecarContextDeniedResult
    | SidecarContextBlockedResult
    | SidecarContextPublishedResult;

type SidecarContextUnavailableInput = SidecarContextAccessInput
    & SidecarContextGateInput
    & Readonly<{
        contextId: string;
        sourceViewId: string;
        capturedAtMs: number;
        navigationGeneration: number;
        kind: SidecarSummaryContextKind;
        lifecycleState?: SidecarContextUnavailableLifecycleState;
        disabledReason?: string;
    }>;

type SidecarPageReferencePublicationInput = SidecarContextAccessInput
    & SidecarContextGateInput
    & SidecarPageReferenceContextInput;

type SidecarScreenshotPublicationInput = SidecarContextAccessInput
    & SidecarContextGateInput
    & SidecarScreenshotContextInput
    & Readonly<{
        lifecycleState?: SidecarContextUnavailableLifecycleState;
        disabledReason?: string;
    }>;

type SidecarContextAttachmentSendInput = Readonly<{
    attachmentId: string;
    contextId: string;
    sourceViewId: string;
    capturedNavigationGeneration: number;
    currentNavigationGeneration: number;
}>;

export type SidecarContextAttachmentSendResult =
    | Readonly<{
        status: 'allowed';
        attachment: BrowserContextAttachmentV1;
    }>
    | Readonly<{
        status: 'blocked';
        reason: 'navigation_stale';
        attachment: BrowserContextAttachmentV1;
    }>;

function denied(): SidecarContextDeniedResult {
    return {
        status: 'denied',
        reason: 'not_owner',
        published: false,
    };
}

function resolveUnavailableLifecycleState(input: SidecarContextGateInput): SidecarContextUnavailableLifecycleState | null {
    if (!input.featureEnabled || !input.policyAllowed) return 'policyDenied';
    if (!input.runtimeAvailable) return 'adapterUnavailable';
    return null;
}

function disabledReasonFor(input: SidecarContextGateInput): string {
    if (!input.featureEnabled) return 'browser.context feature disabled';
    if (!input.policyAllowed) return 'browser context denied by policy';
    if (!input.runtimeAvailable) return 'browser sidecar runtime unavailable';
    return 'browser sidecar context unavailable';
}

function blockedReasonFor(lifecycleState: BrowserContextLifecycleStateV1): SidecarContextBlockedResult['reason'] {
    return lifecycleState === 'adapterUnavailable' || lifecycleState === 'captureFailed'
        ? 'adapter_unavailable'
        : 'policy_denied';
}

function buildPageReferenceUnavailableItem(
    input: SidecarPageReferencePublicationInput,
    lifecycleState: BrowserContextLifecycleStateV1,
): BrowserContextItemV1 {
    return BrowserContextItemV1Schema.parse({
        v: 1,
        contextId: input.contextId,
        kind: 'browserPageReference',
        sourceViewId: input.sourceViewId,
        sourceAdapterKind: 'chromiumSidecar',
        fidelity: 'unavailable',
        capturedAtMs: input.capturedAtMs,
        navigationGeneration: input.navigationGeneration,
        lifecycleState,
        redactionLevel: 'blocked',
        disabledReason: disabledReasonFor(input),
    });
}

export function createSidecarContextPublisher(deps: SidecarContextPublisherDeps): Readonly<{
    publishPageReference: (input: SidecarPageReferencePublicationInput) => SidecarContextPublicationResult;
    publishScreenshotReference: (input: SidecarScreenshotPublicationInput) => SidecarContextPublicationResult;
    publishUnavailable: (input: SidecarContextUnavailableInput) => SidecarContextPublicationResult;
    resolveAttachmentForSend: (input: SidecarContextAttachmentSendInput) => SidecarContextAttachmentSendResult;
}> {
    function isOwner(input: SidecarContextAccessInput): boolean {
        return input.requesterAccountId === deps.ownerAccountId;
    }

    function publishItem(item: BrowserContextItemV1): SidecarContextPublishedResult {
        deps.publish(item);
        return {
            status: 'published',
            published: true,
            item,
            lifecycleState: item.lifecycleState,
        };
    }

    function publishUnavailable(input: SidecarContextUnavailableInput): SidecarContextPublicationResult {
        if (!isOwner(input)) return denied();

        const lifecycleState = resolveUnavailableLifecycleState(input) ?? input.lifecycleState ?? 'adapterUnavailable';
        return publishItem(buildSidecarContextUnavailableItem({
            contextId: input.contextId,
            sourceViewId: input.sourceViewId,
            capturedAtMs: input.capturedAtMs,
            navigationGeneration: input.navigationGeneration,
            kind: input.kind,
            lifecycleState,
            disabledReason: input.disabledReason ?? disabledReasonFor(input),
        }));
    }

    return {
        publishPageReference: (input) => {
            if (!isOwner(input)) return denied();

            const lifecycleState = resolveUnavailableLifecycleState(input);
            if (lifecycleState) {
                return publishItem(buildPageReferenceUnavailableItem(input, lifecycleState));
            }

            return publishItem(buildSidecarPageReferenceContextItem(input));
        },
        publishScreenshotReference: (input) => {
            if (!isOwner(input)) return denied();

            const lifecycleState = resolveUnavailableLifecycleState(input);
            if (lifecycleState) {
                return {
                    status: 'blocked',
                    reason: blockedReasonFor(lifecycleState),
                    published: false,
                    lifecycleState,
                    disabledReason: disabledReasonFor(input),
                };
            }
            if (input.lifecycleState) {
                return {
                    status: 'blocked',
                    reason: blockedReasonFor(input.lifecycleState),
                    published: false,
                    lifecycleState: input.lifecycleState,
                    disabledReason: input.disabledReason ?? disabledReasonFor(input),
                };
            }

            return publishItem(buildSidecarScreenshotContextItem(input));
        },
        publishUnavailable,
        resolveAttachmentForSend: (input) => {
            const attachment = buildSidecarContextAttachment(input);
            if (attachment.state === 'navigationStale') {
                return {
                    status: 'blocked',
                    reason: 'navigation_stale',
                    attachment,
                };
            }
            return {
                status: 'allowed',
                attachment,
            };
        },
    };
}
