import { describe, expect, it, vi } from 'vitest';

import type { PrivateLabelReadPolicyV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import type { MachinePoolPrivateViewV1 } from '@happier-dev/protocol/machines/pools/v1';
import { t } from '@/text';
import type { PrivateLabelOpenInputV1 } from '@/sync/ops/privateLabels/privateLabelClient';

import {
    createMachinePoolPrivateLabelClientForAccount,
    openMachinePoolPrivateViewV1,
} from './machinePoolPrivateLabelProjection';

const poolId = '00000000-0000-4000-8000-000000000001';
const projected = {
    pool: {
        id: poolId,
        name: { kind: 'available' as const, label: { content: { t: 'plain' as const, v: 'Development' }, recipientEnvelope: null } },
        description: { kind: 'available' as const, label: { content: { t: 'plain' as const, v: 'Shared tools' }, recipientEnvelope: null } },
        revision: 1,
        createdAt: 1,
        updatedAt: 2,
        members: [],
    },
    availability: { state: 'known' as const, connectedCount: 0, enabledCount: 0 },
} satisfies MachinePoolPrivateViewV1;

const plainAccountReadPolicy = {
    kind: 'account-owned',
    contentEncryptionMode: 'plain',
} as const satisfies PrivateLabelReadPolicyV1;

function createCapturedPoolLabelClient(contentEncryptionMode: 'plain' | 'e2ee') {
    const resolveAccountMode = vi.fn(async () => contentEncryptionMode);
    const account = {
        accountId: 'pool-owner',
        serverId: 'home-a',
        assertCurrent: () => {},
        resolveAccountMode,
        resolveAccountEncryption: async () => ({ accountMode: contentEncryptionMode, encryption: null }),
        request: async () => new Response(null, { status: 500 }),
    } satisfies Parameters<typeof createMachinePoolPrivateLabelClientForAccount>[0];
    return {
        labels: createMachinePoolPrivateLabelClientForAccount(account),
        resolveAccountMode,
    };
}

describe('Machine Pool private-label projection', () => {
    it('opens recipient-projected labels with their exact Pool field bindings', async () => {
        const open = vi.fn(async ({ label }: PrivateLabelOpenInputV1) => label?.content.t === 'plain' ? label.content.v : null);
        const readPolicyForPool = vi.fn(async () => plainAccountReadPolicy);

        await expect(openMachinePoolPrivateViewV1({ view: projected, labels: { open, readPolicyForPool } })).resolves.toEqual({
            ...projected,
            pool: { ...projected.pool, name: 'Development', description: 'Shared tools' },
        });
        expect(readPolicyForPool).toHaveBeenCalledWith(projected, undefined);
        expect(open).toHaveBeenNthCalledWith(1, {
            binding: { entity: 'machine_pool', field: 'name', id: poolId },
            label: projected.pool.name.label,
            readPolicy: plainAccountReadPolicy,
        });
        expect(open).toHaveBeenNthCalledWith(2, {
            binding: { entity: 'machine_pool', field: 'description', id: poolId },
            label: projected.pool.description.label,
            readPolicy: plainAccountReadPolicy,
        });
    });

    it('keeps the structural Pool usable when a label is unavailable', async () => {
        const open = vi.fn();
        const readPolicyForPool = vi.fn(async () => plainAccountReadPolicy);
        const unavailable = {
            ...projected,
            pool: { ...projected.pool, name: { kind: 'unavailable' as const }, description: { kind: 'unavailable' as const } },
        } satisfies MachinePoolPrivateViewV1;

        await expect(openMachinePoolPrivateViewV1({ view: unavailable, labels: { open, readPolicyForPool } })).resolves.toEqual({
            ...unavailable,
            pool: { ...unavailable.pool, name: t('common.unavailable'), description: null },
        });
        expect(open).not.toHaveBeenCalled();
    });

    it('keeps every structural Pool when one recipient label cannot open', async () => {
        const otherPoolId = '00000000-0000-4000-8000-000000000002';
        const other = {
            ...projected,
            pool: {
                ...projected.pool,
                id: otherPoolId,
                name: { kind: 'available' as const, label: { content: { t: 'plain' as const, v: 'Research' }, recipientEnvelope: null } },
            },
        } satisfies MachinePoolPrivateViewV1;
        const open = vi.fn(async ({ binding, label }: PrivateLabelOpenInputV1) => {
            if (binding.id === poolId && binding.field === 'name') throw new Error('private_label_key_unavailable');
            return label?.content.t === 'plain' ? label.content.v : null;
        });
        const readPolicyForPool = vi.fn(async () => plainAccountReadPolicy);

        await expect(Promise.all([
            openMachinePoolPrivateViewV1({ view: projected, labels: { open, readPolicyForPool } }),
            openMachinePoolPrivateViewV1({ view: other, labels: { open, readPolicyForPool } }),
        ])).resolves.toEqual([
            { ...projected, pool: { ...projected.pool, name: t('common.unavailable'), description: 'Shared tools' } },
            { ...other, pool: { ...other.pool, name: 'Research', description: 'Shared tools' } },
        ]);
    });

    it('does not turn Account-currentness failure into an unavailable Pool label', async () => {
        const currentness = Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' as const });
        const open = vi.fn(async (): Promise<string | null> => { throw currentness; });
        const readPolicyForPool = vi.fn(async () => plainAccountReadPolicy);

        await expect(openMachinePoolPrivateViewV1({ view: projected, labels: { open, readPolicyForPool } })).rejects.toBe(currentness);
    });

    it('refuses plain Account-owned Pool labels for an E2EE Account with one captured mode per page', async () => {
        const other = {
            ...projected,
            pool: {
                ...projected.pool,
                id: '00000000-0000-4000-8000-000000000002',
            },
        } satisfies MachinePoolPrivateViewV1;
        const { labels, resolveAccountMode } = createCapturedPoolLabelClient('e2ee');

        await expect(Promise.all([
            openMachinePoolPrivateViewV1({ view: projected, labels }),
            openMachinePoolPrivateViewV1({ view: other, labels }),
        ])).resolves.toEqual([
            { ...projected, pool: { ...projected.pool, name: t('common.unavailable'), description: null } },
            { ...other, pool: { ...other.pool, name: t('common.unavailable'), description: null } },
        ]);
        expect(resolveAccountMode).toHaveBeenCalledTimes(1);
    });

    it('opens a plain Team Pool label for an E2EE viewer without reading viewer mode', async () => {
        const teamPool = {
            ...projected,
            pool: {
                ...projected.pool,
                audience: { kind: 'team' as const, teamId: 'team-a' },
            },
        } satisfies MachinePoolPrivateViewV1;
        const { labels, resolveAccountMode } = createCapturedPoolLabelClient('e2ee');

        await expect(openMachinePoolPrivateViewV1({ view: teamPool, labels })).resolves.toEqual({
            ...teamPool,
            pool: { ...teamPool.pool, name: 'Development', description: 'Shared tools' },
        });
        expect(resolveAccountMode).not.toHaveBeenCalled();
    });
});
