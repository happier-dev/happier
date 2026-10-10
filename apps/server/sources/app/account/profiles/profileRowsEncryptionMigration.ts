import type { AccountEncryptionMigrateProfileRowsDirective, ProfileRecordContentV1, ProfileRowV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import type { ProfileTransferRowReadResponseV1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import type { Tx } from '@/storage/inTx';
import {
    PROFILE_ACCOUNT_KV_PREFIX, PROFILE_TRANSFER_ACCOUNT_KV_KEY, buildProfilePhysicalKey, parseProfilePhysicalKey,
} from '@/app/kv/accountScopedKv';
import {
    listReservedAccountScopedKvRowsInTx, migrateReservedAccountScopedKvRowsForAccountModeInTx,
    matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx,
    type ReservedAccountScopedKvRowMigrationItem,
} from '@/app/kv/reservedAccountScopedKvRow';
import { profileRecordDomain, readProfileReferenceGuardInTx, markProfileRowChangedInTx } from './profileRows';
import { profileTransferDomain, readProfileTransferControlInTx, markProfileTransferChangedInTx, profileTransferControlReadResponseV1 } from './profileTransferControl';

type Params = Readonly<{ accountId: string; toMode: 'plain' | 'e2ee'; directive?: AccountEncryptionMigrateProfileRowsDirective }>;
type ProfileConversionResult = Readonly<{
    rows: readonly ProfileRowV1[]; referenceGuardRevision: number | 'absent'; transferControl: ProfileTransferRowReadResponseV1;
}>;
type ConversionFailure = Readonly<{ status: 'migration_incomplete' | 'invalid_content' }>;

/** Raw census includes inactive/prepared rows; activation is not conversion admission. */
async function readProfileConversionInventoryInTx(tx: Tx, accountId: string) {
    const rows = await listReservedAccountScopedKvRowsInTx(tx, {
        accountId, physicalPrefix: PROFILE_ACCOUNT_KV_PREFIX, domain: profileRecordDomain,
    });
    if (rows.status !== 'listed') return { status: 'invalid_content' as const };
    if (rows.rows.some(row => {
        const id = parseProfilePhysicalKey(row.physicalKey);
        return id === null || (row.envelope?.t === 'plain' && row.envelope.v.id !== id);
    })) return { status: 'invalid_content' as const };
    const guard = await readProfileReferenceGuardInTx(tx, { accountId });
    if (guard.status !== 'ready') return { status: 'invalid_content' as const };
    const transfer = await readProfileTransferControlInTx(tx, { accountId });
    if (transfer.status !== 'present' && transfer.status !== 'absent' && transfer.status !== 'deleted') {
        return { status: 'invalid_content' as const };
    }
    return { status: 'ready' as const, rows: rows.rows, guardRevision: guard.revision, transfer };
}

function checkCapturedInventory(
    inventory: Extract<Awaited<ReturnType<typeof readProfileConversionInventoryInTx>>, { status: 'ready' }>,
    directive: Params['directive'], replay: boolean,
): ConversionFailure | null {
    if (!directive) {
        return inventory.rows.length !== 0 || inventory.guardRevision !== 'absent' || inventory.transfer.status !== 'absent'
            ? { status: 'migration_incomplete' } : null;
    }
    if (directive.expectedReferenceGuardRevision !== inventory.guardRevision) return { status: 'migration_incomplete' };
    const candidate = directive.transferControl;
    const current = inventory.transfer;
    if (current.status === 'present') {
        if (candidate.content === null || candidate.expectedRevision === 'absent'
            || current.revision !== candidate.expectedRevision + (replay ? 1 : 0)) return { status: 'migration_incomplete' };
    } else if (candidate.content !== null || candidate.expectedRevision !== (current.status === 'absent' ? 'absent' : current.revision)) {
        return { status: 'migration_incomplete' };
    }
    return null;
}

function profileMigrationParams(params: Params) {
    return {
        accountId: params.accountId, toMode: params.toMode, physicalPrefix: PROFILE_ACCOUNT_KV_PREFIX, domain: profileRecordDomain,
        isPhysicalKey: (key: string) => parseProfilePhysicalKey(key) !== null,
        items: (params.directive?.items ?? []).map(item => ({ physicalKey: buildProfilePhysicalKey(item.id), revision: item.expectedRevision, envelope: item.content })),
    };
}

function transferMigrationParams(params: Params) {
    const control = params.directive?.transferControl;
    return {
        accountId: params.accountId, toMode: params.toMode, physicalPrefix: PROFILE_TRANSFER_ACCOUNT_KV_KEY,
        physicalKey: PROFILE_TRANSFER_ACCOUNT_KV_KEY, domain: profileTransferDomain,
        isPhysicalKey: (key: string) => key === PROFILE_TRANSFER_ACCOUNT_KV_KEY,
        items: control && control.content !== null && control.expectedRevision !== 'absent'
            ? [{ physicalKey: PROFILE_TRANSFER_ACCOUNT_KV_KEY, revision: control.expectedRevision, envelope: control.content }] : [],
    };
}

function profileMigrationRows(rows: readonly ReservedAccountScopedKvRowMigrationItem<ProfileRecordContentV1>[], tombstones: readonly ProfileRowV1[]): ProfileRowV1[] {
    return [...rows.map(row => {
        const id = parseProfilePhysicalKey(row.physicalKey);
        if (id === null) throw new Error('Invalid Profile conversion identity');
        return { id, revision: row.revision, content: row.envelope };
    }), ...tombstones];
}

/** Empty-only PATCH has no captured Profile currentness, so introduced state requires migration. */
export async function assertProfileRowsAccountModeMigrationEmptyInTx(tx: Tx, accountId: string): Promise<
    Readonly<{ status: 'empty' }> | ConversionFailure
> {
    const inventory = await readProfileConversionInventoryInTx(tx, accountId);
    if (inventory.status !== 'ready') return inventory;
    return checkCapturedInventory(inventory, undefined, false) ?? { status: 'empty' };
}

/** The incumbent Account transition fence and transaction own rollback of any domain refusal. */
export async function migrateProfileRowsForAccountModeInTx(tx: Tx, params: Params): Promise<
    Readonly<{ status: 'applied' }> & ProfileConversionResult | ConversionFailure
> {
    const inventory = await readProfileConversionInventoryInTx(tx, params.accountId);
    if (inventory.status !== 'ready') return inventory;
    const conflict = checkCapturedInventory(inventory, params.directive, false);
    if (conflict) return conflict;
    const rows = await migrateReservedAccountScopedKvRowsForAccountModeInTx(tx, {
        ...profileMigrationParams(params), markChanged: ({ tx: changeTx, physicalKey, revision }) => {
            const id = parseProfilePhysicalKey(physicalKey);
            if (id === null) throw new Error('Invalid Profile conversion identity');
            return markProfileRowChangedInTx(changeTx, { accountId: params.accountId, id, revision });
        },
    });
    if (rows.status !== 'applied') return rows;
    const transfer = await migrateReservedAccountScopedKvRowsForAccountModeInTx(tx, {
        ...transferMigrationParams(params), markChanged: ({ tx: changeTx, revision }) =>
            markProfileTransferChangedInTx(changeTx, { accountId: params.accountId, revision }),
    });
    if (transfer.status !== 'applied') return transfer;
    const migratedControl = transfer.rows[0];
    return {
        status: 'applied', rows: profileMigrationRows(rows.rows, inventory.rows.filter(row => row.envelope === null).map(row => ({
            id: parseProfilePhysicalKey(row.physicalKey)!, revision: row.revision, content: null,
        }))), referenceGuardRevision: inventory.guardRevision,
        transferControl: migratedControl ? { status: 'present', revision: migratedControl.revision, content: migratedControl.envelope }
            : profileTransferControlReadResponseV1(inventory.transfer),
    };
}

/** Exact lost-response replay observes active envelopes, tombstones and unchanged guard without writes. */
export async function matchProfileRowsAccountMigrationPostStateInTx(tx: Tx, params: Params): Promise<
    Readonly<{ status: 'matched' }> & ProfileConversionResult | Readonly<{ status: 'mismatch' }>
> {
    const inventory = await readProfileConversionInventoryInTx(tx, params.accountId);
    if (inventory.status !== 'ready' || checkCapturedInventory(inventory, params.directive, true)) return { status: 'mismatch' };
    const rows = await matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx(tx, profileMigrationParams(params));
    if (rows.status !== 'matched') return rows;
    const transfer = await matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx(tx, transferMigrationParams(params));
    if (transfer.status !== 'matched') return transfer;
    return {
        status: 'matched', rows: profileMigrationRows(rows.rows, inventory.rows.filter(row => row.envelope === null).map(row => ({
            id: parseProfilePhysicalKey(row.physicalKey)!, revision: row.revision, content: null,
        }))), referenceGuardRevision: inventory.guardRevision, transferControl: profileTransferControlReadResponseV1(inventory.transfer),
    };
}
