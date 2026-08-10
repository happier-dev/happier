import { resolveProviderPromptWithReplaySeed } from '@/agent/runtime/replaySeed/replaySeedV1';
import {
    resolveStructuredInputProviderContextInMeta,
    type StructuredInputCatalogReaders,
} from '@/agent/runtime/prompt/resolveStructuredInputProviderContext';
import { buildSessionReferenceBlockV1 } from '@/agent/runtime/prompt/sessionReferenceBlock';
import { logger } from '@/ui/logger';

/**
 * Prompt finalization: the one place a queued user message becomes the exact prompt and
 * metadata a provider receives (D-21a).
 *
 * remote-dev has FOUR independent prompt-dispatch owners — the ACP family, Codex, Claude and
 * Gemini each run their own loop — so there is no single dispatch site to hook. The module
 * every one of them already shares is the replay seed, which is why finalization is built as
 * an enclosing owner around it rather than as a fifth parallel path. Every send and steer
 * across all four families passes through here.
 */

export type ProviderPromptDispatchSession = Readonly<{
    getMetadataSnapshot: () => unknown;
    updateMetadata: (updater: (metadata: any) => any) => void | Promise<void>;
    refreshSessionSnapshotFromServerBestEffort?: (opts?: { reason: 'connect' | 'waitForMetadataUpdate' }) => Promise<void>;
    ensureMetadataSnapshot?: (opts?: { timeoutMs?: number; abortSignal?: AbortSignal }) => Promise<unknown>;
}>;

export type ResolvedProviderPromptForDispatch = Readonly<{
    providerPrompt: string;
    /** The dispatch metadata, with composer references resolved to provider context. */
    meta: unknown;
    seedApplied: boolean;
    seedText: string;
}>;

export async function resolveProviderPromptForDispatch(params: Readonly<{
    session: ProviderPromptDispatchSession;
    userText: string;
    allowSeed: boolean;
    localId: string | null;
    nowMs: number;
    refreshMetadataBeforeRead: boolean;
    meta?: unknown;
    catalogs?: StructuredInputCatalogReaders;
}>): Promise<ResolvedProviderPromptForDispatch> {
    // Built from the INBOUND metadata, before resolution strips `mentions[]`. It is a text
    // projection, so it reaches every backend family and both directions (send and steer)
    // without a single signature change (D-21a) — including the backends whose prompt call
    // takes only a string.
    const sessionReferenceBlock = buildSessionReferenceBlockV1(params.meta);

    // Reference resolution runs BEFORE the seed, because consuming the replay seed mutates
    // session metadata: a send rejected by D-27 must not have burned the seed on its way out.
    const meta = await resolveStructuredInputProviderContextInMeta({
        meta: params.meta,
        ...(params.catalogs ? { catalogs: params.catalogs } : {}),
        onDiagnostic: (diagnostic) => {
            logger.debug(
                `[PromptDispatch] ${diagnostic.catalog} catalog ${diagnostic.reason}; `
                + `${diagnostic.referenceCount} composer reference(s) contributed no provider item`,
            );
        },
    });

    const seedResolution = await resolveProviderPromptWithReplaySeed({
        session: params.session,
        userText: params.userText,
        allowSeed: params.allowSeed,
        localId: params.localId,
        nowMs: params.nowMs,
        refreshMetadataBeforeRead: params.refreshMetadataBeforeRead,
    });

    return {
        providerPrompt: sessionReferenceBlock
            ? `${seedResolution.providerPrompt}\n\n${sessionReferenceBlock}`
            : seedResolution.providerPrompt,
        meta,
        seedApplied: seedResolution.seedApplied,
        seedText: seedResolution.seedText,
    };
}
