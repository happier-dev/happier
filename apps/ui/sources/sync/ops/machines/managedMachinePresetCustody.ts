import {
    openManagedMachinePresetRecipientProjectionV1,
    type ManagedMachinePresetContentV1,
    type ManagedMachinePresetRecipientProjectionV1,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import type {
    MachineSetupPlanResultV1,
    MachineSetupSourceApplyV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineSetupSourceEntryV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import {
    hydrateManagedOpaqueSetupSourcePresentationsV1,
    type ManagedOpaqueSetupSourcePresentationV1,
} from '@happier-dev/cli-common/machines/managed';

import {
    captureLazyActionAccountContext,
    type LazyActionAccountContext,
} from '@/sync/ops/actions/actionAccountContext';
import { classifyAccountStorageReadFailure } from '@/sync/encryption/accountStorageContext';

type ProjectionOpenParams = Readonly<{
    presetId: string;
    mode: 'plain' | 'e2ee';
    projection: ManagedMachinePresetRecipientProjectionV1;
}>;

/** A captured Plain Account remains deliberately keyless. */
export type ManagedMachinePresetPlainCustodyV1 = Readonly<{
    accountId: string;
    mode: 'plain';
    open(params: ProjectionOpenParams): ManagedMachinePresetContentV1 | null;
    dispose(): void;
}>;

/** Copied E2EE material lives only for an exact recipient-projection open. */
export type ManagedMachinePresetE2eeCustodyV1 = Readonly<{
    accountId: string;
    mode: 'e2ee';
    open(params: ProjectionOpenParams): ManagedMachinePresetContentV1 | null;
    /** Run an in-memory same-DEK operation before this copied key is disposed. */
    withAccountKey<TResult>(operation: (params: Readonly<{ accountId: string; accountKey: Uint8Array }>) => TResult): TResult | null;
    dispose(): void;
}>;
export type ManagedMachinePresetCustodyV1 = ManagedMachinePresetPlainCustodyV1 | ManagedMachinePresetE2eeCustodyV1;

/**
 * One captured Account can open several exact recipient projections during one
 * finite read. It owns copied E2EE material only; its caller retains the
 * Action Account lifetime and must dispose that separately.
 */
export type ManagedMachinePresetReadCustodyV1 = Readonly<{
    open(mode: 'plain' | 'e2ee'): Promise<ManagedMachinePresetCustodyV1 | null>;
    dispose(): Promise<void>;
}>;

export type ManagedMachineSetupSourcePresentationV1 = ManagedOpaqueSetupSourcePresentationV1;

function presentUnresolvedMachineSetupSources(
    sources: MachineSetupSourceApplyV1,
): readonly ManagedMachineSetupSourcePresentationV1[] {
    return sources.map((source) => {
        const local = MachineSetupSourceEntryV1Schema.safeParse(source);
        return local.success
            ? { kind: 'opened' as const, source: local.data }
            : { kind: 'unavailable' as const, source };
    });
}

/**
 * Plain stored content still belongs to the captured Action Account lifetime,
 * but never needs Account encryption material. Keeping that distinction here
 * lets a keyless Plain resource open for an E2EE viewer without treating the
 * viewer's key availability as resource authority.
 */
export function captureManagedMachinePresetPlainCustodyV1(params: Readonly<{
    account: LazyActionAccountContext;
    expectedAccountId?: string;
    signal?: AbortSignal;
}>): ManagedMachinePresetPlainCustodyV1 | null {
    try {
        if (params.expectedAccountId !== undefined && params.account.accountId !== params.expectedAccountId) return null;
        const assertCurrent = () => {
            params.signal?.throwIfAborted();
            params.account.assertCurrent();
        };
        assertCurrent();
        return Object.freeze({
            accountId: params.account.accountId,
            mode: 'plain' as const,
            open: ({ presetId, mode, projection }: ProjectionOpenParams) => {
                assertCurrent();
                return mode === 'plain' ? openManagedMachinePresetRecipientProjectionV1({ presetId, mode, projection }) : null;
            },
            dispose: () => {},
        });
    } catch (error) {
        const reason = classifyAccountStorageReadFailure(error, params.signal);
        if (reason === 'cancelled' || reason === 'scope-retired') throw error;
        return null;
    }
}

/**
 * Capture the existing Action Account's current E2EE material without taking
 * ownership of that Action context. The caller owns context disposal; this
 * custody object owns only its copied private key.
 */
export async function captureManagedMachinePresetCustodyV1(params: Readonly<{
    account: LazyActionAccountContext;
    expectedAccountId?: string;
    /** Stored resource mode selects whether this capture may request E2EE material. */
    resourceMode?: 'plain' | 'e2ee';
    signal?: AbortSignal;
}>): Promise<ManagedMachinePresetCustodyV1 | null> {
    try {
        if (params.expectedAccountId !== undefined && params.account.accountId !== params.expectedAccountId) return null;
        if (params.resourceMode === 'plain') return captureManagedMachinePresetPlainCustodyV1(params);
        const { accountMode, encryption } = await params.account.resolveAccountEncryption(params.signal);
        params.account.assertCurrent();
        const assertCurrent = () => {
            params.signal?.throwIfAborted();
            params.account.assertCurrent();
        };
        if (accountMode === 'plain') return captureManagedMachinePresetPlainCustodyV1(params);
        if (!encryption) return null;
        const accountKey = new Uint8Array(encryption.getContentPrivateKey());
        let disposed = false;
        return Object.freeze({
            accountId: params.account.accountId,
            mode: 'e2ee' as const,
            open: ({ presetId, mode, projection }: ProjectionOpenParams) => {
                assertCurrent();
                if (disposed) return null;
                return mode === 'plain'
                    ? openManagedMachinePresetRecipientProjectionV1({ presetId, mode, projection })
                    : openManagedMachinePresetRecipientProjectionV1({
                        presetId, mode, projection, accountId: params.account.accountId, accountKey,
                    });
            },
            withAccountKey: operation => {
                assertCurrent();
                return disposed ? null : operation({ accountId: params.account.accountId, accountKey });
            },
            dispose: () => {
                if (disposed) return;
                disposed = true;
                accountKey.fill(0);
            },
        });
    } catch (error) {
        const reason = classifyAccountStorageReadFailure(error, params.signal);
        if (reason === 'cancelled' || reason === 'scope-retired') throw error;
        return null;
    }
}

/** Capture only the E2EE branch for readers that do not need a Plain Account context. */
export async function captureManagedMachinePresetE2eeCustodyV1(params: Readonly<{
    account: LazyActionAccountContext;
    expectedAccountId?: string;
    signal?: AbortSignal;
}>): Promise<ManagedMachinePresetE2eeCustodyV1 | null> {
    const custody = await captureManagedMachinePresetCustodyV1({ ...params, resourceMode: 'e2ee' });
    if (custody?.mode === 'e2ee') return custody;
    custody?.dispose();
    return null;
}

/**
 * Lazily selects the captured resource-mode branch once per finite read.
 * Plain projections remain keyless; an E2EE projection obtains one copied
 * current Account key and keeps it only until the containing reader closes.
 */
export function createManagedMachinePresetReadCustodyV1(params: Readonly<{
    account: LazyActionAccountContext;
    expectedAccountId?: string;
    signal?: AbortSignal;
}>): ManagedMachinePresetReadCustodyV1 | null {
    if (params.expectedAccountId !== undefined && params.account.accountId !== params.expectedAccountId) return null;
    let plain: Promise<ManagedMachinePresetCustodyV1 | null> | null = null;
    let e2ee: Promise<ManagedMachinePresetE2eeCustodyV1 | null> | null = null;
    let disposed = false;
    return Object.freeze({
        open: async mode => {
            if (disposed) return null;
            if (mode === 'plain') {
                plain ??= captureManagedMachinePresetCustodyV1({ ...params, resourceMode: 'plain' });
                return await plain;
            }
            e2ee ??= captureManagedMachinePresetE2eeCustodyV1(params);
            return await e2ee;
        },
        dispose: async () => {
            if (disposed) return;
            disposed = true;
            const plainCustody = plain ? await plain : null;
            const e2eeCustody = e2ee ? await e2ee : null;
            plainCustody?.dispose();
            e2eeCustody?.dispose();
        },
    });
}

/**
 * Opens only the exact recipient projections that accompanied one Setup Plan.
 * Its result is local presentation state: the original Plan remains opaque and
 * is the sole source for a later Action Apply.
 */
export async function openManagedMachineSetupPlanSourcesV1(params: Readonly<{
    serverId?: string;
    accountId?: string;
    plan: MachineSetupPlanResultV1;
    signal?: AbortSignal;
}>): Promise<readonly ManagedMachineSetupSourcePresentationV1[]> {
    const { plan } = params;
    const resolvedSources = plan.resolvedSources;
    if (!resolvedSources) return presentUnresolvedMachineSetupSources(plan.sources);
    if (!plan.sources.some((source) => source.kind === 'accountPresetOpaque')) {
        return await hydrateManagedOpaqueSetupSourcePresentationsV1({
            sources: plan.sources,
            resolvedSources,
            open: () => null,
        });
    }

    if (params.serverId === undefined || params.accountId === undefined) {
        return await hydrateManagedOpaqueSetupSourcePresentationsV1({
            sources: plan.sources,
            resolvedSources,
            open: () => null,
        });
    }

    let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
    let custody: ManagedMachinePresetReadCustodyV1 | null = null;
    const unreadable = async () => await hydrateManagedOpaqueSetupSourcePresentationsV1({
        sources: plan.sources,
        resolvedSources,
        open: () => null,
    });
    try {
        account = await captureLazyActionAccountContext(params.serverId, params.signal);
        custody = createManagedMachinePresetReadCustodyV1({
            account,
            expectedAccountId: params.accountId,
            signal: params.signal,
        });
        if (!custody) return await unreadable();
        return await hydrateManagedOpaqueSetupSourcePresentationsV1({
            sources: plan.sources,
            resolvedSources,
            open: async ({ presetId, mode, projection }) => {
                const captured = await custody!.open(mode);
                return openManagedMachinePresetRecipientProjectionAtCustodyV1({
                    presetId,
                    mode,
                    projection,
                    custody: captured,
                });
            },
        });
    } catch (error) {
        const reason = classifyAccountStorageReadFailure(error, params.signal);
        if (reason === 'cancelled' || reason === 'scope-retired') throw error;
        return await unreadable();
    } finally {
        await custody?.dispose();
        account?.dispose();
    }
}

/** Open one exact server projection at the captured Account boundary. */
export function openManagedMachinePresetRecipientProjectionAtCustodyV1(params: Readonly<{
    presetId: string;
    mode: 'plain' | 'e2ee';
    projection: ManagedMachinePresetRecipientProjectionV1;
    custody?: ManagedMachinePresetCustodyV1 | null;
}>): ManagedMachinePresetContentV1 | null {
    if (params.mode === 'plain') return openManagedMachinePresetRecipientProjectionV1({
        presetId: params.presetId, mode: 'plain', projection: params.projection,
    });
    return params.custody?.open({ presetId: params.presetId, mode: params.mode, projection: params.projection }) ?? null;
}
