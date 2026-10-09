import { pluginJsonValuesEqual, type AccountEncryptionMigrateProjectRowsDirective } from '@happier-dev/protocol';
import {
    assertProjectAccountRowContentForModeV1,
    assertProjectAccountRowPayloadBindingV1,
    buildProjectAccountRowPhysicalKeyV1,
    type ProjectAccountRowV1,
} from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { Tx } from '@/storage/inTx';
import { encodeAccountScopedKvJson } from '@/app/kv/accountScopedKv';
import { applyUserKvMutationsInTx } from '@/app/kv/kvMutate';
import { listProjectAccountRowsInTx, markProjectAccountRowChangedInTx } from './projectAccountRowService';

type Params = Readonly<{
    accountId: string;
    toMode: 'plain' | 'e2ee';
    directive?: AccountEncryptionMigrateProjectRowsDirective;
}>;

function indexDirective(params: Params) {
    const items = new Map<string, NonNullable<Params['directive']>['items'][number]>();
    for (const item of params.directive?.items ?? []) {
        const identity = buildProjectAccountRowPhysicalKeyV1(item.key);
        if (items.has(identity)) return null;
        try {
            const content = assertProjectAccountRowContentForModeV1(item.content, params.toMode);
            if (content.t === 'plain') assertProjectAccountRowPayloadBindingV1(item.key, content.v);
        } catch { return null; }
        items.set(identity, item);
    }
    return items;
}

/** The Account transition holds its existing fence and rolls back any rejected domain. */
export async function migrateProjectAccountRowsForAccountModeInTx(tx: Tx, params: Params): Promise<
    | Readonly<{ status: 'applied'; rows: readonly ProjectAccountRowV1[] }>
    | Readonly<{ status: 'migration_incomplete' | 'invalid_content' }>
> {
    const source = await listProjectAccountRowsInTx(tx, { accountId: params.accountId });
    if (source.status !== 'listed') return { status: 'invalid_content' };
    const rows = source.rows.filter(row => row.content !== null);
    const items = indexDirective(params);
    if (!items) return { status: 'invalid_content' };
    if (items.size !== rows.length || rows.some(row => {
        const item = items.get(buildProjectAccountRowPhysicalKeyV1(row.key));
        return !item || item.expectedRevision !== row.revision;
    })) return { status: 'migration_incomplete' };
    if (rows.length === 0) return { status: 'applied', rows: [] };
    const application = await applyUserKvMutationsInTx(tx, { uid: params.accountId }, rows.map(row => {
        const key = buildProjectAccountRowPhysicalKeyV1(row.key);
        const item = items.get(key)!;
        const value = encodeAccountScopedKvJson(item.content);
        if (value === null) throw new Error('Validated Project row cannot be encoded');
        return { key, version: row.revision, value };
    }));
    if (!application.success) return { status: 'migration_incomplete' };
    const migrated: ProjectAccountRowV1[] = [];
    for (const row of rows) {
        const item = items.get(buildProjectAccountRowPhysicalKeyV1(row.key))!;
        const revision = row.revision + 1;
        await markProjectAccountRowChangedInTx(tx, { accountId: params.accountId, key: row.key, revision });
        migrated.push({ key: row.key, revision, content: item.content });
    }
    return { status: 'applied', rows: migrated };
}

/** Exact replay checks the committed envelopes without changing revisions or tombstones. */
export async function matchProjectAccountRowsAccountMigrationPostStateInTx(tx: Tx, params: Params): Promise<
    | Readonly<{ status: 'matched'; rows: readonly ProjectAccountRowV1[] }>
    | Readonly<{ status: 'mismatch' }>
> {
    const state = await listProjectAccountRowsInTx(tx, { accountId: params.accountId });
    if (state.status !== 'listed') return { status: 'mismatch' };
    const rows = state.rows.filter(row => row.content !== null);
    const items = indexDirective(params);
    if (!items || items.size !== rows.length || rows.some(row => {
        const item = items.get(buildProjectAccountRowPhysicalKeyV1(row.key));
        return !item || row.revision !== item.expectedRevision + 1 || !pluginJsonValuesEqual(row.content, item.content);
    })) return { status: 'mismatch' };
    return { status: 'matched', rows };
}
