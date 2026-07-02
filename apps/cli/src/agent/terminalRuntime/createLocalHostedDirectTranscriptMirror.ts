import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { resolveBackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';

import type {
    ExternalSessionExecutionSurface,
    ExternalSessionFollowLease,
} from '@/session/external/providerOps';
import type { LocalHostedDirectTranscriptBinding } from './directTranscriptBinding';

type LocalHostedDirectTranscriptProviderOps = Readonly<{
    validateSource: NonNullable<ExternalSessionExecutionSurface['validateSource']>;
    pageTranscript: NonNullable<ExternalSessionExecutionSurface['pageTranscript']>;
    readAfterTranscript: NonNullable<ExternalSessionExecutionSurface['readAfterTranscript']>;
    acquireFollowLease?: ExternalSessionExecutionSurface['acquireFollowLease'];
}>;

function resolvePageMaxBytes(): number {
    const raw = Number.parseInt(String(process.env.HAPPIER_EXTERNAL_SESSIONS_PAGE_MAX_BYTES ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 512_000;
    return Math.max(1024, Math.min(10 * 1024 * 1024, configured));
}

function resolvePageMaxItems(): number {
    const raw = Number.parseInt(String(process.env.HAPPIER_EXTERNAL_SESSIONS_PAGE_MAX_ITEMS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 200;
    return Math.max(1, Math.min(5000, configured));
}

async function replayTranscriptHistory(params: Readonly<{
    source: LocalHostedDirectTranscriptBinding['source'];
    remoteSessionId: string;
    providerOps: LocalHostedDirectTranscriptProviderOps;
    onItems: (items: readonly ExternalSessionTranscriptRawMessageV1[]) => Promise<void> | void;
}>): Promise<string | null> {
    const pages: ExternalSessionTranscriptRawMessageV1[][] = [];
    let tailCursor: string | null = null;
    let cursor: string | undefined;

    while (true) {
        const page = await params.providerOps.pageTranscript({
            source: params.source,
            remoteSessionId: params.remoteSessionId,
            direction: 'older',
            cursor,
            maxBytes: resolvePageMaxBytes(),
            maxItems: resolvePageMaxItems(),
            allowProviderFallback: !params.providerOps.acquireFollowLease,
        });
        tailCursor ??= page.tailCursor;

        if (page.items.length > 0) {
            pages.push(page.items.slice());
        }
        if (!page.hasMore || !page.nextCursor) {
            break;
        }
        cursor = page.nextCursor;
    }

    for (let index = pages.length - 1; index >= 0; index -= 1) {
        await params.onItems(pages[index] ?? []);
    }

    return tailCursor;
}

async function bridgeTranscriptHandoffGap(params: Readonly<{
    source: LocalHostedDirectTranscriptBinding['source'];
    remoteSessionId: string;
    providerOps: LocalHostedDirectTranscriptProviderOps;
    fromCursor: string | null;
    toCursor: string | null;
    onItems: (items: readonly ExternalSessionTranscriptRawMessageV1[]) => Promise<void> | void;
}>): Promise<void> {
    if (!params.fromCursor || !params.toCursor || params.fromCursor === params.toCursor) {
        return;
    }

    let cursor = params.fromCursor;
    const visitedCursors = new Set<string>([cursor]);

    while (cursor !== params.toCursor) {
        const page = await params.providerOps.readAfterTranscript({
            source: params.source,
            remoteSessionId: params.remoteSessionId,
            cursor,
            maxBytes: resolvePageMaxBytes(),
            maxItems: resolvePageMaxItems(),
            allowProviderFallback: false,
        });

        if (page.items.length > 0) {
            await params.onItems(page.items);
        }

        const nextCursor = page.nextCursor;
        if (!nextCursor || visitedCursors.has(nextCursor)) {
            return;
        }

        cursor = nextCursor;
        visitedCursors.add(cursor);
    }
}

async function resolveExternalSessionSurface(
    providerId: LocalHostedDirectTranscriptBinding['providerId'],
): Promise<ExternalSessionExecutionSurface> {
    const externalSession = (await resolveBackendExecutionSurfaces(providerId)).externalSession;
    if (!externalSession) {
        throw new Error(`Unsupported external-session provider: ${providerId}`);
    }
    return externalSession;
}

function requireLocalHostedDirectTranscriptProviderOps(
    providerId: LocalHostedDirectTranscriptBinding['providerId'],
    providerOps: ExternalSessionExecutionSurface,
): LocalHostedDirectTranscriptProviderOps {
    if (!providerOps.validateSource) {
        throw new Error(`Unsupported external-session provider: ${providerId} missing validateSource`);
    }
    if (!providerOps.pageTranscript) {
        throw new Error(`Unsupported external-session provider: ${providerId} missing pageTranscript`);
    }
    if (!providerOps.readAfterTranscript) {
        throw new Error(`Unsupported external-session provider: ${providerId} missing readAfterTranscript`);
    }
    return {
        validateSource: providerOps.validateSource,
        pageTranscript: providerOps.pageTranscript,
        readAfterTranscript: providerOps.readAfterTranscript,
        ...(providerOps.acquireFollowLease ? { acquireFollowLease: providerOps.acquireFollowLease } : {}),
    };
}

export function createLocalHostedDirectTranscriptMirror(params: Readonly<{
    binding: LocalHostedDirectTranscriptBinding;
    onItems: (items: readonly ExternalSessionTranscriptRawMessageV1[]) => Promise<void> | void;
    getProviderOps?: (providerId: LocalHostedDirectTranscriptBinding['providerId']) => Promise<ExternalSessionExecutionSurface>;
}>) {
    let startPromise: Promise<void> | null = null;
    let stopRequested = false;
    let released = false;
    let followLease: ExternalSessionFollowLease | null = null;
    let unsubscribe: (() => void) | null = null;
    let deliveryChain: Promise<void> = Promise.resolve();
    let initialReplayComplete = false;
    const bufferedFollowUpdates: ExternalSessionTranscriptRawMessageV1[][] = [];

    const deliverItems = async (items: readonly ExternalSessionTranscriptRawMessageV1[]): Promise<void> => {
        if (items.length === 0 || stopRequested) return;

        const nextDelivery = deliveryChain.then(async () => {
            if (stopRequested) return;
            await params.onItems(items);
        });
        deliveryChain = nextDelivery.catch(() => undefined);
        await nextDelivery;
    };

    const releaseFollowLease = async (): Promise<void> => {
        if (released) return;
        released = true;

        const release = followLease?.release ?? null;
        followLease = null;

        const detach = unsubscribe;
        unsubscribe = null;
        try {
            detach?.();
        } catch {
            // Best-effort cleanup only.
        }

        await release?.().catch(() => undefined);
    };

    const ensureStarted = async (): Promise<void> => {
        const providerOps = requireLocalHostedDirectTranscriptProviderOps(
            params.binding.providerId,
            await (params.getProviderOps ?? resolveExternalSessionSurface)(params.binding.providerId),
        );
        const validation = await providerOps.validateSource({
            source: params.binding.source,
            env: params.binding.env ?? process.env,
        });
        if (!validation.ok) {
            throw new Error(validation.error);
        }

        const source = validation.source;

        if (providerOps.acquireFollowLease) {
            const replayTailCursor = await replayTranscriptHistory({
                source,
                remoteSessionId: params.binding.remoteSessionId,
                providerOps,
                onItems: deliverItems,
            });
            if (stopRequested) {
                return;
            }

            followLease = await providerOps.acquireFollowLease({
                source,
                remoteSessionId: params.binding.remoteSessionId,
                reason: 'attached_view',
            });
            if (!followLease || stopRequested) {
                await releaseFollowLease();
                return;
            }

            if (typeof followLease.subscribeToTranscriptUpdates === 'function') {
                unsubscribe = followLease.subscribeToTranscriptUpdates((update) => {
                    const items = Array.from(update.items);
                    if (items.length === 0 || stopRequested) {
                        return;
                    }
                    if (!initialReplayComplete) {
                        bufferedFollowUpdates.push(items);
                        return;
                    }
                    void deliverItems(items);
                });
            }

            const followLeaseTailCursor = followLease.getTailCursor?.() ?? null;

            await bridgeTranscriptHandoffGap({
                source,
                remoteSessionId: params.binding.remoteSessionId,
                providerOps,
                fromCursor: replayTailCursor,
                toCursor: followLeaseTailCursor,
                onItems: deliverItems,
            });
        } else {
            await replayTranscriptHistory({
                source,
                remoteSessionId: params.binding.remoteSessionId,
                providerOps,
                onItems: deliverItems,
            });
            if (stopRequested) {
                return;
            }
        }

        initialReplayComplete = true;
        while (bufferedFollowUpdates.length > 0) {
            const items = bufferedFollowUpdates.shift();
            if (!items) {
                continue;
            }
            await deliverItems(items);
        }
    };

    return {
        async start(): Promise<void> {
            if (startPromise) {
                await startPromise;
                return;
            }
            startPromise = ensureStarted();
            try {
                await startPromise;
            } catch (error) {
                await releaseFollowLease();
                throw error;
            }
        },
        async stop(): Promise<void> {
            stopRequested = true;
            if (startPromise) {
                await startPromise.catch(() => undefined);
            }
            await releaseFollowLease();
            await deliveryChain.catch(() => undefined);
        },
    };
}
