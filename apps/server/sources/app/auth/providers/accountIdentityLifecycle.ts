import type { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { afterTx, inTx, type Tx } from '@/storage/inTx';
import { isPrismaErrorCode } from '@/storage/prisma';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { acquireAccountSessionOwnerMetadataFencesInTx } from '@/app/encryption/accountSessionOwnerMetadataFence';
import { fetchLinkedProvidersForAccounts } from '@/app/auth/providers/linkedProviders';
import { buildUpdateAccountUpdate, eventRouter } from '@/app/events/eventRouter';
import { randomKeyNaked } from '@/utils/keys/randomKeyNaked';
import { buildAccountIdentitiesChangeV1 } from '@happier-dev/protocol/changes';
import type { PreparedIdentityConnection } from './identityProviders/types';
import { buildLinkedIdentityManagementProjectionInTx } from './accountLinkedIdentityManagement';
import { isAccountIdentityEligibleForGenericPresentation } from '@/app/auth/methods/registry';
import { changeUsernameInTx } from '@/app/social/usernameUpdate';

export type IdentityManagementDeniedReason = 'required_by_team' | 'last_login_method' | 'management_unavailable';

export class IdentityManagementDeniedError extends Error {
    readonly reason: IdentityManagementDeniedReason;

    constructor(reason: IdentityManagementDeniedReason) {
        super('identity-management-denied');
        this.name = 'IdentityManagementDeniedError';
        this.reason = reason;
    }
}

async function readIdentityManagementInTx(tx: Tx, input: { accountId: string; provider: string }) {
    const provider = input.provider.trim().toLowerCase();
    const projection = await buildLinkedIdentityManagementProjectionInTx(tx, {
        accountId: input.accountId,
        env: process.env,
    });
    return projection.find((item) => item.providerId === provider) ?? null;
}

export class ProviderAlreadyLinkedError extends Error {
    constructor() {
        super('provider-already-linked');
        this.name = 'ProviderAlreadyLinkedError';
    }
}

export interface IdentityLinkIntent {
    accountId: string;
    provider: string;
    providerUserId: string;
    providerLogin: string | null;
    profile: Prisma.InputJsonValue;
    token?: Uint8Array<ArrayBuffer> | null;
    scopes?: string | null;
    showOnProfile?: boolean;
    /**
     * Provider eligibility is part of the same identity-link mutation. Keeping these fields on the
     * intent prevents provider leaves from performing a second AccountIdentity write after the
     * lifecycle owner has prepared the row.
     */
    eligibility?: Pick<Prisma.AccountIdentityUncheckedCreateInput,
        'eligibilityStatus' | 'eligibilityReason' | 'eligibilityCheckedAt' | 'eligibilityNextCheckAt'>;
    presentation?: {
        username?: string | null;
        name?: string | null;
        avatar?: Exclude<Prisma.AccountUncheckedUpdateInput['avatar'], undefined>;
    };
    /** GitHub's existing same-subject reconnect is intentionally a no-op. */
    sameSubject?: 'unchanged';
    /** Only the authenticated provider-reset composition supplies this source. */
    transferFromAccountId?: string;
    usernamePolicyEnv?: NodeJS.ProcessEnv;
}

async function publishIdentityChanges(tx: Tx, accountIdsInput: readonly string[]): Promise<void> {
    const accountIds = [...new Set(accountIdsInput)].sort();
    if (accountIds.length === 0) return;
    const accounts = await tx.account.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, name: true, username: true, avatar: true },
        orderBy: { id: 'asc' },
    });
    if (accounts.length !== accountIds.length) throw new Error('account-not-found');
    const linkedProvidersByAccountId = await fetchLinkedProvidersForAccounts({
        tx,
        accountIds,
    });

    for (const account of accounts) {
        const { id: accountId, ...profile } = account;
        const linkedProviders = linkedProvidersByAccountId.get(accountId) ?? [];
        // Its own coalescing row: a same-transaction or later `self` write cannot replace it.
        const cursor = await markAccountChanged(tx, { accountId, ...buildAccountIdentitiesChangeV1() });
        afterTx(tx, () => {
            eventRouter.emitUpdate({
                userId: accountId,
                payload: buildUpdateAccountUpdate(accountId, { ...profile, linkedProviders }, cursor.resolveCursor(), randomKeyNaked(12)),
                recipientFilter: { type: 'user-scoped-only' },
            });
        });
    }
}

async function publishIdentityChange(tx: Tx, accountId: string): Promise<void> {
    await publishIdentityChanges(tx, [accountId]);
}

async function checkLink(reader: Pick<Tx, 'accountIdentity'>, intent: Pick<IdentityLinkIntent, 'accountId' | 'provider' | 'providerUserId' | 'transferFromAccountId'>) {
    const collision = await reader.accountIdentity.findFirst({
        where: { provider: intent.provider, providerUserId: intent.providerUserId, NOT: { accountId: intent.accountId } },
        select: { id: true, accountId: true },
    });
    if (collision && collision.accountId !== intent.transferFromAccountId) throw new ProviderAlreadyLinkedError();
    return await reader.accountIdentity.findFirst({
        where: { accountId: intent.accountId, provider: intent.provider },
        select: { id: true, providerUserId: true, showOnProfile: true },
    });
}

export async function preflightIdentityLink(intent: Pick<IdentityLinkIntent, 'accountId' | 'provider' | 'providerUserId' | 'transferFromAccountId'>): Promise<boolean> {
    const existing = await checkLink(db, intent);
    return existing?.providerUserId === intent.providerUserId;
}

/** Prepare outside the transaction; repeat collision checks at the actual mutation boundary. */
export async function prepareIdentityLink(intent: IdentityLinkIntent): Promise<PreparedIdentityConnection> {
    await checkLink(db, intent);
    return { connectInTx: (tx) => linkIdentityInTx(tx, intent) };
}

export async function linkIdentityInTx(tx: Tx, intent: IdentityLinkIntent): Promise<void> {
    await acquireAccountSessionOwnerMetadataFencesInTx(tx,
        [intent.accountId, ...(intent.transferFromAccountId ? [intent.transferFromAccountId] : [])], "exclusive");
    const existing = await checkLink(tx, intent);
    if (existing?.providerUserId === intent.providerUserId && intent.sameSubject === 'unchanged') return;
    const account = await tx.account.findUnique({
        where: { id: intent.accountId },
        select: { username: true, name: true, avatar: true },
    });
    if (!account) throw new Error('account-not-found');
    let transferredVisibility = existing?.showOnProfile;
    if (intent.transferFromAccountId) {
        const source = await tx.accountIdentity.findFirst({
            where: { accountId: intent.transferFromAccountId, provider: intent.provider, providerUserId: intent.providerUserId },
            select: { showOnProfile: true },
        });
        if (!source) throw new ProviderAlreadyLinkedError();
        transferredVisibility = source.showOnProfile;
        const removed = await tx.accountIdentity.deleteMany({
            where: { accountId: intent.transferFromAccountId, provider: intent.provider, providerUserId: intent.providerUserId },
        });
        if (removed.count !== 1) throw new ProviderAlreadyLinkedError();
        await publishIdentityChange(tx, intent.transferFromAccountId);
    }
    if (existing && existing.providerUserId !== intent.providerUserId) {
        // A new external subject is a new identity lifetime. Outstanding refreshes
        // name the old row and cannot overwrite the explicitly relinked identity.
        await tx.accountIdentity.delete({ where: { id: existing.id } });
    }
    const requestedVisibility = intent.showOnProfile ?? transferredVisibility;
    const data = {
        providerUserId: intent.providerUserId,
        providerLogin: intent.providerLogin,
        profile: intent.profile,
        ...(intent.token !== undefined ? { token: intent.token } : {}),
        ...(intent.scopes !== undefined ? { scopes: intent.scopes } : {}),
        ...(isAccountIdentityEligibleForGenericPresentation(process.env, intent.provider)
            ? (requestedVisibility !== undefined ? { showOnProfile: requestedVisibility } : {})
            : { showOnProfile: false }),
        ...(intent.eligibility ?? {}),
    };
    // The account/provider slot may be explicitly relinked, but the external subject
    // is never looked up by email or moved to a different provider namespace.
    try {
        await tx.accountIdentity.upsert({
            where: { accountId_provider: { accountId: intent.accountId, provider: intent.provider } },
            create: { accountId: intent.accountId, provider: intent.provider, ...data },
            update: data,
        });
    } catch (error) {
        if (isPrismaErrorCode(error, 'P2002')) throw new ProviderAlreadyLinkedError();
        throw error;
    }
    const proposal = intent.presentation;
    if (proposal) {
        if (proposal.username) {
            await changeUsernameInTx(tx, intent.accountId, { kind: 'identity_fill', suggestion: proposal.username }, intent.usernamePolicyEnv);
        }
        await tx.account.update({ where: { id: intent.accountId }, data: {
            ...(!account.name?.trim() && proposal.name?.trim() ? { name: proposal.name.trim() } : {}),
            ...(!account.avatar && proposal.avatar ? { avatar: proposal.avatar } : {}),
        } });
    }
    await publishIdentityChange(tx, intent.accountId);
}

export async function unlinkIdentityInTx(tx: Tx, input: { accountId: string; provider: string; clearMatchingUsername?: string | null }): Promise<void> {
    await acquireAccountSessionOwnerMetadataFencesInTx(tx, [input.accountId], "exclusive");
    const management = await readIdentityManagementInTx(tx, input);
    if (management && !management.canDisconnect) {
        throw new IdentityManagementDeniedError(management.disconnectReason ?? 'management_unavailable');
    }
    const { count } = await tx.accountIdentity.deleteMany({ where: { accountId: input.accountId, provider: input.provider } });
    if (!count) return;
    if (input.clearMatchingUsername) {
        await changeUsernameInTx(tx, input.accountId, { kind: 'identity_unlink', matchingUsername: input.clearMatchingUsername });
    }
    await publishIdentityChange(tx, input.accountId);
}

export async function unlinkIdentity(input: Parameters<typeof unlinkIdentityInTx>[1]): Promise<void> {
    await inTx((tx) => unlinkIdentityInTx(tx, input), { isolationLevel: "Serializable" /* Final-login viability spans identity, password, provider policy and Home-owner rows. */ });
}

export async function readProviderLinkedAccountIdsInTx(tx: Tx, provider: string): Promise<readonly string[]> {
    const identities = await tx.accountIdentity.findMany({
        where: { provider },
        select: { accountId: true },
        orderBy: { accountId: 'asc' },
    });
    return [...new Set(identities.map(({ accountId }) => accountId))];
}

/**
 * Removes every identity in one managed provider namespace after the provider
 * owner has completed its own login-stranding preflight.
 */
export async function removeIdentitiesForProviderInTx(
    tx: Tx,
    provider: string,
): Promise<readonly string[]> {
    const accountIds = await readProviderLinkedAccountIdsInTx(tx, provider);
    if (accountIds.length === 0) return [];
    await acquireAccountSessionOwnerMetadataFencesInTx(tx, accountIds, "exclusive");
    await tx.accountIdentity.deleteMany({ where: { provider } });
    await publishIdentityChanges(tx, accountIds);
    return accountIds;
}

/**
 * Republishes the linked-provider projection for one provider namespace after the provider
 * instance itself changed presentation or currentness. The identity rows are untouched, but what
 * they project to a member — display name, and whether the provider can still be used — has
 * changed. Resolution stays set-based so a provider edit costs one publication pass, not one
 * catalog resolution per linked Account.
 */
export async function publishProviderLinkedIdentityChangesInTx(
    tx: Tx,
    provider: string,
): Promise<readonly string[]> {
    const accountIds = await readProviderLinkedAccountIdsInTx(tx, provider);
    if (accountIds.length === 0) return [];
    await publishIdentityChanges(tx, accountIds);
    return accountIds;
}

export type IdentityRefresh = Pick<Prisma.AccountIdentityUncheckedUpdateInput,
    'providerLogin' | 'profile' | 'token' | 'scopes' | 'eligibilityStatus' | 'eligibilityReason' | 'eligibilityCheckedAt' | 'eligibilityNextCheckAt'>;

export async function refreshIdentity(input: { accountId: string; provider: string; identityId: string; data: IdentityRefresh }): Promise<void> {
    await inTx(async (tx) => {
        // Identity replacement/removal uses the same exclusive Account fence.
        // ReadCommitted observes its committed lifetime after waiting; the exact
        // identity id prevents a delayed refresh from updating a replacement.
        await acquireAccountSessionOwnerMetadataFencesInTx(tx, [input.accountId], "exclusive");
        const { count } = await tx.accountIdentity.updateMany({
            where: { id: input.identityId, accountId: input.accountId, provider: input.provider }, data: input.data,
        });
        if (count) await publishIdentityChange(tx, input.accountId);
    });
}

export async function setIdentityVisibilityInTx(tx: Tx, input: { accountId: string; provider: string; showOnProfile: boolean }): Promise<boolean> {
    if (!isAccountIdentityEligibleForGenericPresentation(process.env, input.provider)) return false;
    await acquireAccountSessionOwnerMetadataFencesInTx(tx, [input.accountId], "content");
    const management = await readIdentityManagementInTx(tx, input);
    if (management && !management.canPublishProfile) {
        throw new IdentityManagementDeniedError(management.publishProfileReason ?? 'management_unavailable');
    }
    const { count } = await tx.accountIdentity.updateMany({
        where: { accountId: input.accountId, provider: input.provider }, data: { showOnProfile: input.showOnProfile },
    });
    if (count) await publishIdentityChange(tx, input.accountId);
    return count > 0;
}

/** Called inside the provider instance's revision-checked delete transaction. */
export async function findIdentityProviderBlockers(tx: Tx, provider: string) {
    return tx.accountIdentity.findMany({ where: { provider }, select: { id: true, accountId: true } });
}
