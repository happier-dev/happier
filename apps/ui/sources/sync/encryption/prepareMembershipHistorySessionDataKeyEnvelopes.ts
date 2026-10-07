import { ENCRYPTED_DATA_KEY_V1_BYTES } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import type { MembershipSessionDataKeyEnvelopeExceptionsV1, MembershipSessionDataKeyEnvelopeItemV1, MembershipSessionDataKeyEnvelopePageV1, PatchMembershipSessionDataKeyEnvelopesResultV1, PatchMembershipSessionDataKeyEnvelopesV1 } from '@happier-dev/protocol/sessions/encryption/membershipSessionDataKeyEnvelopes';

import {
    encryptDataKeyForRecipientV0,
    verifyRecipientContentPublicKeyBinding,
    SESSION_DATA_KEY_SEAL_CHUNK_SIZE,
} from './directShareEncryption';
import { mapCryptoBatchWithYield } from './cryptoBatchYield';
import type { EncryptionGenerationScopeAuthority, EncryptionScopeInput } from './encryption';
import type { ScopedRpcSessionEncryptionContext } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import {
    runSessionDataKeyPreparationPass,
    type SessionDataKeyPreparationProgress,
} from '@happier-dev/protocol/sessions/encryption/sessionDataKeyPreparationPass';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';

/**
 * Invoking-client preparation for a Team/Group membership's eligible Session history.
 *
 * The operation is foreground and in-memory: it discovers bounded work from the membership
 * resource, opens the caller's own Session envelopes through the existing Account batch-open owner,
 * reseals the same Session DEKs to the target Account, and commits one bounded page at a time. It
 * owns no access decision — eligibility, the history horizon, and the recipient's key readiness are
 * all resolved by their canonical owners and consumed here as a worklist.
 *
 * It performs no fallback of any kind: a caller envelope that will not open is surfaced as repair
 * work, never replaced by Account-scoped material, which is not transferable to another Account.
 *
 * One process-local resumable pass only: no durable job, ledger, worker or scheduler. Committed
 * pages survive interruption because the worklist is derived from canonical access plus
 * missing/invalid tuples; the next explicit pass resumes from the same resource.
 */

/**
 * The only facts the crypto pass consumes: the Home identity that scopes
 * encryption generation and qualified Session addresses, plus the captured
 * discovery target echoed on PATCH.
 *
 * The exact Team/Group route, membership identity and Account realm are bound
 * once at the transport host, which owns path construction and currentness. The
 * pass never receives a second membership discriminator or realm field: retaining
 * them beside the bound transport would imply another authority without reading it.
 */
export type MembershipHistoryPreparationScope = Readonly<{
    serverId: string;
    /** The discovery target echoed on PATCH, independently of the membership identity. */
    recipientAccountId: string;
}>;

export type MembershipSessionDataKeyEnvelopeTransport = Readonly<{
    fetchPage: (cursor: string | null) => Promise<MembershipSessionDataKeyEnvelopePageV1>;
    patchPage: (
        request: PatchMembershipSessionDataKeyEnvelopesV1,
    ) => Promise<PatchMembershipSessionDataKeyEnvelopesResultV1>;
}>;

type RecipientUnavailableReason = Extract<
    MembershipSessionDataKeyEnvelopePageV1,
    { status: 'recipient_unavailable' }
>['contentKey']['reason'];

export type MembershipHistoryPreparationStatus =
    | 'complete'
    | 'incomplete'
    | 'scope_changed'
    /** The target Account cannot receive envelopes at all; membership stays active. */
    | 'recipient_unavailable'
    /** The membership now resolves to a different Account than the captured discovery target. */
    | 'recipient_changed'
    /** The addressed Team or Group membership disappeared while the pass was committing. */
    | 'membership_changed'
    /** The returned content key is not bound by the Account that claims it. */
    | 'invalid_recipient_binding';

export type MembershipHistoryPreparationOutcome = Readonly<{
    status: MembershipHistoryPreparationStatus;
    /** Sessions the server confirmed it committed. */
    preparedCount: number;
    /** Sessions this pass could not prepare locally; they remain retryable user work. */
    skippedCount: number;
    /** Qualified addresses of Sessions whose own caller envelope needs repair. */
    repairRequiredSessions: readonly SessionAddress[];
    recipientUnavailableReason: RecipientUnavailableReason | null;
    /** Truthful counts of manageable-but-not-actionable Sessions, as reported by the last page. */
    exceptions: MembershipSessionDataKeyEnvelopeExceptionsV1 | null;
}>;

/**
 * The canonical Account encryption owner, taken as one contract.
 *
 * Both halves come from the same producer, so this pass never probes for a method: it opens the
 * page's caller envelopes through the batch owner and asks that same owner whether the material it
 * captured is still current. A partial owner would leave the pass unable to tell a still-valid
 * scope from an unanswerable question, and it would answer "still current" either way.
 */
export type MembershipHistoryPreparationEncryption =
    Pick<ScopedRpcSessionEncryptionContext, 'decryptEncryptionKeys'> & EncryptionGenerationScopeAuthority;

export type PrepareMembershipHistoryParams = Readonly<{
    scope: MembershipHistoryPreparationScope;
    transport: MembershipSessionDataKeyEnvelopeTransport;
    /** The canonical Account key-opening owner; it owns Protocol/native routing and telemetry. */
    encryption: MembershipHistoryPreparationEncryption;
    /** Home/Account/membership authority captured by the host when the operation started. */
    isHostScopeCurrent: () => boolean;
    onProgress?: (progress: SessionDataKeyPreparationProgress) => void;
    sealChunkSize?: number;
    yieldBetweenChunks?: () => Promise<void>;
}>;

type StopReason = Readonly<{
    status: Exclude<MembershipHistoryPreparationStatus, 'complete' | 'incomplete' | 'scope_changed'>;
    recipientUnavailableReason?: RecipientUnavailableReason;
}>;

type VerifiedTargetBinding = Readonly<{ contentPublicKeyB64: string }>;

/**
 * Verifies the page's target binding through the one canonical recipient-binding verifier, which
 * owns the wire encodings this resource actually uses: `accountSigningPublicKey` is Hex and the
 * content key and signature are canonical Base64. An unverifiable binding stops the operation
 * instead of downgrading to a guess.
 */
function verifyTargetBinding(
    contentKey: Extract<MembershipSessionDataKeyEnvelopePageV1, { status: 'ready' }>['contentKey'],
): VerifiedTargetBinding | null {
    if (contentKey.status !== 'available') return null;
    const verified = verifyRecipientContentPublicKeyBinding({
        signingPublicKeyHex: contentKey.accountSigningPublicKey,
        contentPublicKeyB64: contentKey.contentPublicKey,
        contentPublicKeySigB64: contentKey.contentPublicKeySignature,
    });
    return verified ? { contentPublicKeyB64: contentKey.contentPublicKey } : null;
}

export async function prepareMembershipHistorySessionDataKeyEnvelopes(
    params: PrepareMembershipHistoryParams,
): Promise<MembershipHistoryPreparationOutcome> {
    const { scope, transport, encryption } = params;
    const encryptionScope: EncryptionScopeInput = { serverId: scope.serverId };
    const capturedEncryptionScope = encryption.getCurrentEncryptionGenerationScope(encryptionScope);

    const isScopeCurrent = () => {
        if (!params.isHostScopeCurrent()) return false;
        return encryption.isCurrentEncryptionGenerationScope(capturedEncryptionScope);
    };

    const stop: { reason: StopReason | null } = { reason: null };
    let binding: VerifiedTargetBinding | null = null;
    let exceptions: MembershipSessionDataKeyEnvelopeExceptionsV1 | null = null;
    const repairRequiredSessions: SessionAddress[] = [];

    const passResult = await runSessionDataKeyPreparationPass<
        MembershipSessionDataKeyEnvelopeItemV1,
        PatchMembershipSessionDataKeyEnvelopesV1['entries'][number]
    >({
        fetchPage: async (cursor) => {
            // A stable recipient failure ends this pass, including its optional final recheck.
            if (stop.reason) return { items: [], nextCursor: null };
            const page = await transport.fetchPage(cursor);
            // Fetch may resolve after a Home/Account switch: do not verify keys or publish status.
            if (!isScopeCurrent()) return { items: [], nextCursor: null };
            if (page.status === 'recipient_unavailable') {
                stop.reason = { status: 'recipient_unavailable', recipientUnavailableReason: page.contentKey.reason };
                return { items: [], nextCursor: null };
            }
            if (page.recipientAccountId !== scope.recipientAccountId) {
                stop.reason = { status: 'recipient_changed' };
                return { items: [], nextCursor: null };
            }
            // The target binding is verified once per page, not once per Session.
            const verified = verifyTargetBinding(page.contentKey);
            if (!verified) {
                stop.reason = { status: 'invalid_recipient_binding' };
                return { items: [], nextCursor: null };
            }
            binding = verified;
            // Continuation pages deliberately omit the global aggregate so the
            // server can advance by DB keyset without reparsing the whole
            // history. Retain the latest authoritative cursorless value.
            if (page.exceptions !== null) exceptions = page.exceptions;
            return { items: page.items, nextCursor: page.nextCursor };
        },
        itemKey: (item) => item.sessionId,
        prepareEntries: async (items) => {
            const targetBinding = binding;
            if (!targetBinding) return { entries: [], failedItemKeys: items.map((item) => item.sessionId) };

            // One batched open for the whole page: the client never depends on a warm Session cache
            // and never issues a Session-detail request per item.
            const openedKeys = await encryption.decryptEncryptionKeys(
                items.map((item) => item.callerDataKeyEnvelope),
                encryptionScope,
            );

            const sealable: Array<Readonly<{ sessionId: string; dataKey: Uint8Array }>> = [];
            const failedItemKeys: string[] = [];
            items.forEach((item, index) => {
                const dataKey = openedKeys[index] ?? null;
                if (!dataKey || dataKey.byteLength !== ENCRYPTED_DATA_KEY_V1_BYTES) {
                    failedItemKeys.push(item.sessionId);
                    const address = normalizeSessionAddress(scope.serverId, item.sessionId);
                    if (address) repairRequiredSessions.push(address);
                    return;
                }
                sealable.push({ sessionId: item.sessionId, dataKey });
            });

            const entries = await mapCryptoBatchWithYield(
                sealable,
                (candidate) => ({
                    sessionId: candidate.sessionId,
                    encryptedDataKey: encryptDataKeyForRecipientV0(
                        candidate.dataKey,
                        targetBinding.contentPublicKeyB64,
                    ),
                }),
                {
                    chunkSize: params.sealChunkSize ?? SESSION_DATA_KEY_SEAL_CHUNK_SIZE,
                    ...(params.yieldBetweenChunks === undefined
                        ? {}
                        : { yieldBetweenChunks: params.yieldBetweenChunks }),
                },
            );
            return { entries, failedItemKeys };
        },
        commitEntries: async (entries) => {
            const result = await transport.patchPage({
                recipientAccountId: scope.recipientAccountId,
                entries: [...entries],
            });
            return result.appliedCount;
        },
        isScopeCurrent,
        ...(params.onProgress ? { onProgress: params.onProgress } : {}),
    });

    const stopReason = stop.reason;
    return {
        status: passResult.status === 'scope_changed' ? 'scope_changed' : stopReason ? stopReason.status : passResult.status,
        preparedCount: passResult.preparedCount,
        skippedCount: passResult.skippedCount,
        repairRequiredSessions,
        recipientUnavailableReason: stopReason?.recipientUnavailableReason ?? null,
        exceptions,
    };
}
