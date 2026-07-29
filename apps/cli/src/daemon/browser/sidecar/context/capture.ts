import {
    BrowserContextAttachmentV1Schema,
    BrowserContextItemV1Schema,
    type BrowserContextAttachmentV1,
    type BrowserContextItemV1,
    type BrowserContextKindV1,
    type BrowserContextLifecycleStateV1,
    type BrowserScreenshotMediaReferenceV1,
    type BrowserTargetDisplayV1,
    type BrowserViewTargetKindV1,
} from '@happier-dev/protocol';

import {
    redactSidecarContextUrl,
    resolveSidecarContextOrigin,
} from '../diagnostics/redaction';

type SidecarContextBaseInput = Readonly<{
    contextId: string;
    sourceViewId: string;
    capturedAtMs: number;
    navigationGeneration: number;
}>;

export type SidecarScreenshotContextInput = SidecarContextBaseInput & Readonly<{
    media: BrowserScreenshotMediaReferenceV1;
}>;

export function buildSidecarScreenshotContextItem(input: SidecarScreenshotContextInput): BrowserContextItemV1 {
    return BrowserContextItemV1Schema.parse({
        v: 1,
        contextId: input.contextId,
        kind: 'browserScreenshot',
        sourceViewId: input.sourceViewId,
        sourceAdapterKind: 'chromiumSidecar',
        fidelity: 'cdp',
        capturedAtMs: input.capturedAtMs,
        navigationGeneration: input.navigationGeneration,
        lifecycleState: 'available',
        redactionLevel: 'metadataOnly',
        media: input.media,
    });
}

export type SidecarPageReferenceContextInput = SidecarContextBaseInput & Readonly<{
    targetId?: string;
    targetKind?: BrowserViewTargetKindV1;
    display?: BrowserTargetDisplayV1;
    url?: string;
    title?: string;
    faviconUrl?: string;
}>;

export function buildSidecarPageReferenceContextItem(input: SidecarPageReferenceContextInput): BrowserContextItemV1 {
    const redactedUrl = redactSidecarContextUrl(input.url);
    const redactedFaviconUrl = redactSidecarContextUrl(input.faviconUrl);
    const origin = resolveSidecarContextOrigin(input.url);

    return BrowserContextItemV1Schema.parse({
        v: 1,
        contextId: input.contextId,
        kind: 'browserPageReference',
        sourceViewId: input.sourceViewId,
        sourceAdapterKind: 'chromiumSidecar',
        fidelity: 'cdp',
        capturedAtMs: input.capturedAtMs,
        navigationGeneration: input.navigationGeneration,
        lifecycleState: 'available',
        redactionLevel: 'metadataOnly',
        ...(input.targetId ? { targetId: input.targetId } : {}),
        ...(input.targetKind ? { targetKind: input.targetKind } : {}),
        ...(input.display ? { display: input.display } : {}),
        ...(redactedUrl ? { url: redactedUrl } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(redactedFaviconUrl ? { faviconUrl: redactedFaviconUrl } : {}),
        ...(origin ? { origin } : {}),
    });
}

export type SidecarSummaryContextKind = Extract<
    BrowserContextKindV1,
    | 'browserPageTextSummary'
    | 'browserDomSnapshotSummary'
    | 'browserNetworkSummary'
    | 'browserConsoleSummary'
>;

export type SidecarSummaryContextInput = SidecarContextBaseInput & Readonly<{
    kind: SidecarSummaryContextKind;
    summary: string;
    truncated?: boolean;
}>;

export function buildSidecarSummaryContextItem(input: SidecarSummaryContextInput): BrowserContextItemV1 {
    return BrowserContextItemV1Schema.parse({
        v: 1,
        contextId: input.contextId,
        kind: input.kind,
        sourceViewId: input.sourceViewId,
        sourceAdapterKind: 'chromiumSidecar',
        fidelity: 'cdp',
        capturedAtMs: input.capturedAtMs,
        navigationGeneration: input.navigationGeneration,
        lifecycleState: 'available',
        redactionLevel: 'summaryOnly',
        summary: input.summary,
        truncated: input.truncated ?? false,
    });
}

export type SidecarUnavailableContextInput = SidecarContextBaseInput & Readonly<{
    kind: SidecarSummaryContextKind;
    lifecycleState: Extract<
        BrowserContextLifecycleStateV1,
        'adapterUnavailable' | 'captureFailed' | 'policyDenied' | 'sensitiveOrigin'
    >;
    disabledReason: string;
}>;

export function buildSidecarContextUnavailableItem(input: SidecarUnavailableContextInput): BrowserContextItemV1 {
    return BrowserContextItemV1Schema.parse({
        v: 1,
        contextId: input.contextId,
        kind: input.kind,
        sourceViewId: input.sourceViewId,
        sourceAdapterKind: 'chromiumSidecar',
        fidelity: 'unavailable',
        capturedAtMs: input.capturedAtMs,
        navigationGeneration: input.navigationGeneration,
        lifecycleState: input.lifecycleState,
        redactionLevel: 'blocked',
        disabledReason: input.disabledReason,
        summary: '',
        truncated: false,
    });
}

export function buildSidecarContextAttachment(input: Readonly<{
    attachmentId: string;
    contextId: string;
    sourceViewId: string;
    capturedNavigationGeneration: number;
    currentNavigationGeneration: number;
}>): BrowserContextAttachmentV1 {
    const isStale = input.currentNavigationGeneration !== input.capturedNavigationGeneration;

    return BrowserContextAttachmentV1Schema.parse({
        v: 1,
        attachmentId: input.attachmentId,
        contextId: input.contextId,
        sourceViewId: input.sourceViewId,
        capturedNavigationGeneration: input.capturedNavigationGeneration,
        currentNavigationGeneration: input.currentNavigationGeneration,
        state: isStale ? 'navigationStale' : 'available',
        requiresReconfirmBeforeSend: isStale,
    });
}
