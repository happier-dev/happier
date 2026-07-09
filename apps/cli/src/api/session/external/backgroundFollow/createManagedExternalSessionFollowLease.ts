import type { ExternalSessionTranscriptDeltaEphemeral } from '@happier-dev/protocol';

import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import { resolveReadyNotificationAssistantText } from '@/agent/runtime/notifications/resolveReadyNotificationAssistantText';
import type { ExternalSessionFollowLease, ExternalSessionFollowLeaseReason } from '@/session/external/providerOps';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import type { Credentials } from '@/persistence';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readCredentials } from '@/persistence';

import {
    deriveExternalSessionObservedProgress,
    updateSessionMetadataWithObservedExternalSessionProgress,
} from './externalSessionBackgroundFollowMetadata';
import { buildExternalSessionReadyNotificationPreview } from './buildExternalSessionReadyNotificationPreview';

type MetadataWriteContext = Readonly<{
    token: string;
    credentials: Credentials;
    rawSession: NonNullable<Awaited<ReturnType<typeof fetchSessionById>>>;
    sessionTitle: string | null;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function resolveSessionTitle(metadata: Record<string, unknown> | null | undefined): string | null {
    const summary = asRecord(metadata?.summary);
    const summaryText = typeof summary?.text === 'string' ? summary.text.trim() : '';
    if (summaryText) return summaryText;
    const name = typeof metadata?.name === 'string' ? metadata.name.trim() : '';
    return name || null;
}

async function resolveMetadataWriteContext(sessionId: string): Promise<MetadataWriteContext | null> {
    const credentials = await readCredentials().catch(() => null);
    if (!credentials) return null;
    const rawSession = await fetchSessionById({
        token: credentials.token,
        sessionId,
    }).catch(() => null);
    if (!rawSession) return null;
    const metadata = tryDecryptSessionMetadata({
        credentials,
        rawSession,
    });
    return {
        token: credentials.token,
        credentials,
        rawSession,
        sessionTitle: resolveSessionTitle(asRecord(metadata)),
    };
}

export async function createManagedExternalSessionFollowLease(params: Readonly<{
    sessionId: string;
    reason: ExternalSessionFollowLeaseReason;
    acquireProviderFollowLease: () => Promise<ExternalSessionFollowLease | null>;
    emitExternalSessionTranscriptUpdate?: (payload: ExternalSessionTranscriptDeltaEphemeral) => void;
    shouldProcessBackgroundFollowEffects: () => boolean;
}>): Promise<ExternalSessionFollowLease | null> {
    const acquiredLease = await params.acquireProviderFollowLease();
    if (!acquiredLease) {
        return null;
    }
    if (typeof acquiredLease.subscribeToTranscriptUpdates !== 'function') {
        return acquiredLease;
    }

    let released = false;
    let providerLeaseReleased = false;
    let metadataWriteContextPromise: Promise<MetadataWriteContext | null> | null = null;

    const releaseProviderLease = async (): Promise<void> => {
        if (providerLeaseReleased) return;
        providerLeaseReleased = true;
        await acquiredLease.release().catch(() => undefined);
    };

    const resolveCachedMetadataWriteContext = async (): Promise<MetadataWriteContext | null> => {
        if (!metadataWriteContextPromise) {
            metadataWriteContextPromise = resolveMetadataWriteContext(params.sessionId);
        }
        return metadataWriteContextPromise;
    };

    const unsubscribe = acquiredLease.subscribeToTranscriptUpdates(async (update) => {
        if (released) return;

        if (params.emitExternalSessionTranscriptUpdate) {
            await Promise.resolve(params.emitExternalSessionTranscriptUpdate({
                type: 'direct-session-transcript-delta',
                sessionId: params.sessionId,
                items: Array.from(update.items),
                fromCursor: update.fromCursor,
                nextCursor: update.nextCursor,
                truncated: update.truncated,
            })).catch(() => undefined);
        }

        if (params.reason !== 'background_follow' || !params.shouldProcessBackgroundFollowEffects()) {
            return;
        }

        const metadataContext = await resolveCachedMetadataWriteContext().catch(() => null);
        const observedProgress = deriveExternalSessionObservedProgress(update.items);
        const lastKnownActivityAtMs = observedProgress?.atMs ?? null;

        if (metadataContext && (observedProgress || lastKnownActivityAtMs !== null)) {
            await updateSessionMetadataWithObservedExternalSessionProgress({
                token: metadataContext.token,
                credentials: metadataContext.credentials,
                sessionId: params.sessionId,
                rawSession: metadataContext.rawSession,
                observedProgress,
                lastKnownActivityAtMs,
            }).catch(() => undefined);
        }

        const previewText = resolveReadyNotificationAssistantText({
            explicitAssistantText: buildExternalSessionReadyNotificationPreview(update.items),
        });
        if (!previewText) {
            return;
        }

        const snapshot = getActiveAccountSettingsSnapshot();
        if (!snapshot || snapshot.source === 'none') {
            return;
        }

        await dispatchActivityNotificationAsync({
            settings: snapshot.settings,
            settingsSecretsReadKeys: snapshot.settingsSecretsReadKeys,
            event: {
                topic: 'ready',
                sessionId: params.sessionId,
                sessionTitle: metadataContext?.sessionTitle ?? null,
                waitingForCommandLabel: metadataContext?.sessionTitle ?? params.sessionId,
                assistantPreviewText: previewText,
            },
        }).catch(() => undefined);
    });

    return {
        release: async () => {
            released = true;
            try {
                unsubscribe();
            } catch {
                // Best-effort cleanup only.
            }
            await releaseProviderLease();
        },
        getTailCursor: typeof acquiredLease.getTailCursor === 'function'
            ? () => acquiredLease.getTailCursor?.() ?? null
            : undefined,
        subscribeToTranscriptUpdates: acquiredLease.subscribeToTranscriptUpdates,
    };
}
