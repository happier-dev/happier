import {
    ENCRYPTED_DATA_KEY_V1_BYTES,
    prepareSessionDataKeyEnvelopeItemV1,
    runSessionDataKeyPreparationPass,
    type SessionDataKeyPreparationProgress,
    type PatchSessionDataKeyEnvelopesResultV1,
    type PatchSessionDataKeyEnvelopesV1,
    type SessionDataKeyEnvelopeItemV1,
    type SessionDataKeyEnvelopePageV1,
    type SessionDataKeyEnvelopeSummaryV1,
    type SessionDataKeyRecipientUnavailableReasonV1,
} from '@happier-dev/protocol';
import { isCapturedEncryptionGenerationScopeCurrent } from './encryption';

import { SESSION_DATA_KEY_SEAL_CHUNK_SIZE } from './directShareEncryption';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { mapCryptoBatchWithYield } from './cryptoBatchYield';
import type {
    EncryptionGenerationScope,
    EncryptionGenerationScopeAuthority,
    EncryptionScopeInput,
} from './encryption';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

/**
 * Invoking-client preparation for one current Session's Team/Group/direct recipient audience.
 *
 * This is the sibling of the membership-history operation: same bounded page → seal → atomic commit
 * loop (owned once by `runSessionDataKeyPreparationPass`), different worklist. Here the manager
 * already holds one opened Session DEK and fans it out across the Session's deduplicated audience,
 * whereas history holds one recipient and fans out across Sessions.
 *
 * It owns no access decision. The audience, each recipient's key readiness, and stored envelope
 * state are resolved by their canonical owners and consumed here as a worklist. It performs no
 * fallback: a recipient whose advertised binding does not verify is skipped as an exception, never
 * sealed to an unverified key.
 */

export type CurrentSessionPreparationScope = Readonly<{
    /**
     * Lane 07's qualified Session identity. Home-local requests still send only `sessionId`; this
     * address exists so progress, results and host state can never key cross-Home work by a bare id
     * two Homes may both issue. The exact Home/Account authority and route are bound once at the
     * transport host; the pass consumes only this server identity plus encryption generation and
     * currentness, never a second realm field.
     */
    session: SessionAddress;
}>;

export type CurrentSessionDataKeyEnvelopeTransport = Readonly<{
    fetchPage: (cursor: string | null) => Promise<SessionDataKeyEnvelopePageV1>;
    patchPage: (
        request: PatchSessionDataKeyEnvelopesV1,
    ) => Promise<PatchSessionDataKeyEnvelopesResultV1>;
}>;

export type CurrentSessionPreparationStatus =
    | 'complete'
    | 'incomplete'
    | 'scope_changed'
    /** The Session is plain: it needs no recipient key material at all. */
    | 'not_required'
    /** This device holds no transferable standalone Session DEK, so nothing can be prepared. */
    | 'session_data_key_unavailable';

export type CurrentSessionRecipientSetupException = Readonly<{
    recipientAccountId: string;
    reason: SessionDataKeyRecipientUnavailableReasonV1;
}>;

export type CurrentSessionPreparationOutcome = Readonly<{
    status: CurrentSessionPreparationStatus;
    /** Recipients the server confirmed it committed. Never a locally sealed count. */
    preparedCount: number;
    /** Recipients this pass could not prepare; they remain truthful, retryable user work. */
    skippedCount: number;
    /**
     * The server's own Session-scoped aggregate from the last page observed, which is what the
     * Collaboration row renders. It is not recomputed locally from the pages this pass happened to
     * see, so it keeps describing the whole authorized audience rather than this pass's slice.
     */
    summary: SessionDataKeyEnvelopeSummaryV1 | null;
    /** Recipients whose Account cannot receive an envelope, with the exact reason to explain. */
    recipientsNeedingSetup: readonly CurrentSessionRecipientSetupException[];
    /** Recipients whose advertised content key was not signed by the Account claiming it. */
    invalidBindingRecipients: readonly string[];
}>;

/**
 * Committed progress against the Home's own actionable total.
 *
 * For audience preparation, `actionableTotal` is the authoritative `pending + invalid`
 * the collection reported; an explicit single-recipient repair has one requested unit.
 * Neither is a count of the rows this pass happened to seal or of the grants
 * the editor happens to show. It only ever grows: the one final recheck may
 * reveal work committed behind the cursor, and a denominator that shrank mid-pass
 * would make an honest 12-of-18 look like a finished 12-of-12.
 */
export type CurrentSessionPreparationProgress = SessionDataKeyPreparationProgress & Readonly<{
    actionableTotal: number | null;
}>;

export type PrepareCurrentSessionParams = Readonly<{
    /**
     * The Session storage mode its own owner already resolved. A plain Session is
     * keyless by definition, so it is settled here rather than by asking the Home
     * for a recipient audience it would only answer `not_required` for — and
     * rather than by the absence of local key material, which is what an E2EE
     * Session this device cannot open also looks like.
     */
    sessionEncryptionMode: 'plain' | 'e2ee';
    /** Explicit repair from the diagnostic, including a structurally prepared envelope. */
    reprepareRecipientAccountId?: string;
    scope: CurrentSessionPreparationScope;
    transport: CurrentSessionDataKeyEnvelopeTransport;
    /**
     * The standalone per-Session DEK this client already opened. `null` (or any non-32-byte value)
     * means there is nothing transferable to share: an Account-scoped compatibility reader is not a
     * Session key and must never be sealed to another Account.
     */
    sessionDataKey: Uint8Array | null;
    /** Home/Account/Session authority captured by the host when the operation started. */
    isHostScopeCurrent: () => boolean;
    /**
     * Generation scoping from the canonical Account encryption owner.
     *
     * Optional because a caller may hold no Account encryption at all (a plain Account opens
     * nothing), but never method-optional: when an owner is supplied it answers both questions, so
     * this pass never has to guess whether it can ask.
     */
    encryption?: EncryptionGenerationScopeAuthority;
    /**
     * Generation captured immediately before an async host opened `sessionDataKey`.
     *
     * The transport host supplies this when key opening precedes this pass. Capturing only after
     * the open would let bytes opened under generation N be treated as generation N+1 if Account
     * encryption reset while the open was in flight. Direct callers that already hold current
     * bytes may omit it and let this owner capture at entry.
     */
    capturedEncryptionScope?: EncryptionGenerationScope;
    onProgress?: (progress: CurrentSessionPreparationProgress) => void;
    sealChunkSize?: number;
    yieldBetweenChunks?: () => Promise<void>;
}>;

export async function prepareCurrentSessionDataKeyEnvelopes(
    params: PrepareCurrentSessionParams,
): Promise<CurrentSessionPreparationOutcome> {
    const { scope, transport, sessionDataKey } = params;

    const recipientsNeedingSetup: CurrentSessionRecipientSetupException[] = [];
    const invalidBindingRecipients: string[] = [];
    let summary: SessionDataKeyEnvelopeSummaryV1 | null = null;

    const settled = (
        status: CurrentSessionPreparationStatus,
        counts?: Readonly<{ preparedCount: number; skippedCount: number }>,
    ): CurrentSessionPreparationOutcome => ({
        status,
        preparedCount: counts?.preparedCount ?? 0,
        skippedCount: counts?.skippedCount ?? 0,
        summary,
        recipientsNeedingSetup,
        invalidBindingRecipients,
    });

    // A plain Session settles first, and still only while the captured scope holds: answering
    // `not_required` after a Home/Account switch would report the new scope's Session as needing
    // no work using the old scope's mode.
    if (params.sessionEncryptionMode === 'plain') {
        return settled(params.isHostScopeCurrent() ? 'not_required' : 'scope_changed');
    }

    // Step 1 of the contract: assert a transferable standalone DEK *before* discovering anything.
    // Without usable material there is no reason to ask the Home for recipient identities.
    if (!sessionDataKey || sessionDataKey.byteLength !== ENCRYPTED_DATA_KEY_V1_BYTES) {
        return settled('session_data_key_unavailable');
    }

    const encryptionScope: EncryptionScopeInput = { serverId: scope.session.serverId };
    const encryption = params.encryption ?? null;
    const capturedEncryptionScope = params.capturedEncryptionScope
        ?? encryption?.getCurrentEncryptionGenerationScope(encryptionScope)
        ?? null;

    const isScopeCurrent = () => {
        if (!params.isHostScopeCurrent()) return false;
        return isCapturedEncryptionGenerationScopeCurrent(encryption, capturedEncryptionScope);
    };

    let plainSession = false;
    /** Committed so far, so the observed total can be stated as committed + still actionable. */
    let committedCount = 0;
    let actionableTotal: number | null = null;

    const passResult = await runSessionDataKeyPreparationPass<
        SessionDataKeyEnvelopeItemV1,
        PatchSessionDataKeyEnvelopesV1['entries'][number]
    >({
        fetchPage: async (cursor) => {
            const page = await transport.fetchPage(cursor);
            if (!isScopeCurrent()) return { items: [], nextCursor: null };
            if (page.status === 'not_required') {
                plainSession = true;
                return { items: [], nextCursor: null };
            }
            // Continuations deliberately omit the aggregate so the server can
            // advance from the recipient keyset without rescanning the prefix.
            // Retain the latest authoritative cursorless discovery/recheck.
            if (page.summary !== null) {
                summary = page.summary;
                // The Home's own actionable count, taken as a whole-Session fact rather than
                // from this page's rows. Recipients whose Account cannot hold a key are not in
                // it: they are not work this pass can finish.
                const observedTotal = params.reprepareRecipientAccountId === undefined
                    ? committedCount + page.summary.pending + page.summary.invalid
                    : 1;
                actionableTotal = Math.max(actionableTotal ?? 0, observedTotal);
            }
            return {
                items: params.reprepareRecipientAccountId === undefined
                    ? page.items
                    : page.items.filter(item => item.recipientAccountId === params.reprepareRecipientAccountId),
                nextCursor: page.nextCursor,
            };
        },
        itemKey: (item) => item.recipientAccountId,
        prepareEntries: async (items) => {
            const failedItemKeys: string[] = [];
            // Verification is asymmetric crypto too. Keep it in the same measured cooperative
            // chunk as sealing, including pages whose bindings all fail verification.
            const prepared = await mapCryptoBatchWithYield(
                items,
                (item) => {
                    const classified = prepareSessionDataKeyEnvelopeItemV1({ item, sessionDataKey, randomBytes: getRandomBytes });
                    if (classified.kind === 'setup_required') {
                        failedItemKeys.push(item.recipientAccountId);
                        recipientsNeedingSetup.push({ recipientAccountId: item.recipientAccountId, reason: classified.reason });
                        return null;
                    }
                    if (classified.kind === 'invalid_binding') {
                        failedItemKeys.push(item.recipientAccountId);
                        invalidBindingRecipients.push(item.recipientAccountId);
                        return null;
                    }
                    return classified.entry;
                },
                {
                    chunkSize: params.sealChunkSize ?? SESSION_DATA_KEY_SEAL_CHUNK_SIZE,
                    ...(params.yieldBetweenChunks === undefined
                        ? {}
                        : { yieldBetweenChunks: params.yieldBetweenChunks }),
                },
            );
            const entries = prepared.filter((entry) => entry !== null);
            return { entries, failedItemKeys };
        },
        commitEntries: async (entries) => {
            const result = await transport.patchPage({ entries: [...entries] });
            return result.appliedCount;
        },
        isScopeCurrent,
        ...(params.onProgress ? {
            onProgress: (progress) => {
                committedCount = progress.preparedCount;
                params.onProgress?.({ ...progress, actionableTotal });
            },
        } : {}),
    });

    const counts = {
        preparedCount: passResult.preparedCount,
        skippedCount: passResult.skippedCount,
    };
    if (passResult.status === 'scope_changed') return settled('scope_changed', counts);
    if (plainSession) return settled('not_required', counts);
    // A targeted repair deliberately reads `all`: the Home cannot tell whether valid-shaped
    // ciphertext opens on the recipient. Its acknowledged exact-recipient PATCH settles this
    // narrow operation; the diagnostic may still list that recipient as prepared on recheck.
    // Ordinary audience preparation retains the generic pass's remaining-work verdict.
    if (params.reprepareRecipientAccountId !== undefined) {
        return settled(counts.preparedCount === 1 && counts.skippedCount === 0 ? 'complete' : 'incomplete', counts);
    }
    return settled(passResult.status, counts);
}
