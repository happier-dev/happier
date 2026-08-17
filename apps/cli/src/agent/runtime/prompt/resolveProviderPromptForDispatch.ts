import {
    HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
    MENTION_BOUNDS,
    sanitizeMentionRefsV1,
} from '@happier-dev/protocol';

import { fitHappierReplaySeedWithinTotalBudget } from '@happier-dev/agents';

import { configuration } from '@/configuration';
import {
    resolveProviderPromptWithReplaySeed,
    type ReplaySeedSettlementResultV1,
} from '@/agent/runtime/replaySeed/replaySeedV1';
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

/**
 * D-27: the total resolved reference context in one message is bounded, and exceeding it
 * rejects the send rather than silently truncating references the user selected.
 *
 * `maxReferenceBlockChars` bounds the session text block on its own — inside that block the
 * overflow policy is to drop trailing entries and SAY SO, which is bounded and visible.
 * `maxResolvedContextChars` is the cross-kind total, so a message cannot assemble an unbounded
 * provider context out of several individually-bounded kinds.
 */
export class ResolvedMentionContextTooLargeError extends Error {
    readonly code = 'mention_resolved_context_too_large';
    readonly totalChars: number;
    readonly maxChars: number;

    constructor(totalChars: number, maxChars: number) {
        super(
            `Resolved composer reference context is ${totalChars} characters, over the ${maxChars} `
            + 'character limit for one message. Remove some references and send again.',
        );
        this.name = 'ResolvedMentionContextTooLargeError';
        this.totalChars = totalChars;
        this.maxChars = maxChars;
    }
}

function readResolvedContextChars(meta: unknown, key: 'skillMentions' | 'vendorPluginMentions'): number {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return 0;
    const envelope = (meta as Record<string, unknown>)[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1];
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return 0;
    const records = (envelope as Record<string, unknown>)[key];
    if (!Array.isArray(records) || records.length === 0) return 0;
    // The serialized records are exactly what the provider adapters read, so their length is the
    // context this message spends — not an approximation of it.
    return JSON.stringify(records).length;
}

function countInboundReferences(meta: unknown): number {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return 0;
    const envelope = (meta as Record<string, unknown>)[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1];
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return 0;
    return sanitizeMentionRefsV1((envelope as Record<string, unknown>).mentions).length;
}

export type ResolvedProviderPromptForDispatch = Readonly<{
    providerPrompt: string;
    /** The dispatch metadata, with composer references resolved to provider context. */
    meta: unknown;
    seedApplied: boolean;
    seedText: string;
    /**
     * Retire the replay seed. The caller invokes this only after the provider ACCEPTED
     * this prompt; a prompt rejected before effect leaves the seed live for the retry.
     */
    settleReplaySeedOnProviderAcceptance: () => Promise<ReplaySeedSettlementResultV1>;
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

    // D-27's total bound, checked here because this is the only place both projections of the
    // resolved context exist. It runs BEFORE the seed for the same reason resolution does: a
    // send rejected by the bound must not have burned the replay seed on its way out.
    //
    // Only a message that actually carried references is measured. A legacy envelope's per-kind
    // arrays are provider context this resolver never produced, and bounding them here would
    // reject sends that have nothing to do with composer references.
    if (countInboundReferences(params.meta) > 0) {
        const totalChars = (sessionReferenceBlock?.length ?? 0)
            + readResolvedContextChars(meta, 'skillMentions')
            + readResolvedContextChars(meta, 'vendorPluginMentions');
        if (totalChars > MENTION_BOUNDS.maxResolvedContextChars) {
            throw new ResolvedMentionContextTooLargeError(totalChars, MENTION_BOUNDS.maxResolvedContextChars);
        }
    }

    const seedResolution = await resolveProviderPromptWithReplaySeed({
        session: params.session,
        userText: params.userText,
        allowSeed: params.allowSeed,
        localId: params.localId,
        nowMs: params.nowMs,
        refreshMetadataBeforeRead: params.refreshMetadataBeforeRead,
    });

    if (!sessionReferenceBlock) {
        return {
            providerPrompt: seedResolution.providerPrompt,
            meta,
            seedApplied: seedResolution.seedApplied,
            seedText: seedResolution.seedText,
            settleReplaySeedOnProviderAcceptance: seedResolution.settleReplaySeedOnProviderAcceptance,
        };
    }

    // ONE total, not two. The seed's cap is enforced when the seed is built, but
    // the Session-reference block is appended here — so without this the prompt
    // exceeds the configured seed cap by up to the reference bound. The seed
    // gives way, never the reference block: the block carries Session
    // identities that must not be truncated, and the seed states its own loss.
    //
    // Only an APPLIED seed is refitted. When no seed was applied the prompt is
    // the user's own message plus the reference block, and clipping the user's
    // text is not this owner's decision.
    const fittedSeedText = seedResolution.seedApplied
        ? fitHappierReplaySeedWithinTotalBudget({
            seedText: seedResolution.seedText,
            reservedChars: sessionReferenceBlock.length + 2,
            maxPromptChars: configuration.replaySeedMaxChars,
        })
        : '';
    const promptBody = seedResolution.seedApplied
        ? (fittedSeedText ? `${fittedSeedText}\n\n${params.userText}` : params.userText)
        : seedResolution.providerPrompt;

    return {
        providerPrompt: `${promptBody}\n\n${sessionReferenceBlock}`,
        meta,
        seedApplied: seedResolution.seedApplied,
        seedText: fittedSeedText || seedResolution.seedText,
        settleReplaySeedOnProviderAcceptance: seedResolution.settleReplaySeedOnProviderAcceptance,
    };
}
