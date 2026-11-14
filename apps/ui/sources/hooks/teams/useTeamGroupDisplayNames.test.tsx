import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamGroupV1 } from '@happier-dev/protocol/teams';

import { renderHook, standardCleanup } from '@/dev/testkit';

const open = vi.hoisted(() => vi.fn());
const isPrivateLabelLifecycleFailureV1 = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/privateLabels/privateLabelClient', () => ({
    createPrivateLabelClient: () => ({ open }),
    isPrivateLabelLifecycleFailureV1,
}));

import { useTeamGroupDisplayNames } from './useTeamGroupDisplayNames';

function group(id: string, value: string): TeamGroupV1 {
    return {
        v: 1,
        id,
        teamId: 'team-1',
        name: {
            kind: 'available',
            label: { content: { t: 'plain', v: value }, recipientEnvelope: null },
        },
        description: null,
        archivedAt: null,
        memberCount: 0,
        management: { kind: 'native' },
        capabilities: {
            updateMetadata: true,
            archive: true,
            restore: false,
            manageNativeMembers: true,
        },
    };
}

describe('useTeamGroupDisplayNames', () => {
    afterEach(async () => {
        await standardCleanup();
        open.mockReset();
        isPrivateLabelLifecycleFailureV1.mockReset();
    });

    it('keeps every loaded Group structural row when one recipient label opener rejects', async () => {
        open.mockImplementation((input: Readonly<{ binding: Readonly<{ id: string }> }>) => (
            input.binding.id === 'group-unavailable'
                ? Promise.reject(new Error('recipient key unavailable'))
                : Promise.resolve('Visible Group')
        ));
        const groups = [
            group('group-unavailable', 'opaque unavailable label'),
            group('group-visible', 'opaque visible label'),
        ];
        const hook = await renderHook(() => useTeamGroupDisplayNames({
            scope: { serverId: 'server-1', accountId: 'account-1' },
            groups,
        }));

        await vi.waitFor(() => {
            expect([...hook.getCurrent()]).toEqual([
                ['group-unavailable', null],
                ['group-visible', 'Visible Group'],
            ]);
        });
    });

    it('opens Team-backed Group labels under the resource-arm reader policy', async () => {
        open.mockResolvedValue('Visible Group');
        const groups = [group('group-visible', 'opaque visible label')];
        const hook = await renderHook(() => useTeamGroupDisplayNames({
            scope: { serverId: 'server-1', accountId: 'account-1' },
            groups,
        }));

        await vi.waitFor(() => {
            expect([...hook.getCurrent()]).toEqual([['group-visible', 'Visible Group']]);
        });
        expect(open).toHaveBeenCalledWith(expect.objectContaining({
            readPolicy: { kind: 'team-resource' },
        }));
    });

    it('does not publish sibling names after an Account lifecycle refusal', async () => {
        const lifecycleError = Object.assign(new Error('Account context retired'), {
            code: 'action_account_scope_changed',
        });
        isPrivateLabelLifecycleFailureV1.mockImplementation((error: unknown) => error === lifecycleError);
        open.mockImplementation((input: Readonly<{
            binding: Readonly<{ id: string }>;
            label: Readonly<{ content: Readonly<{ t: 'plain'; v: string }> }>;
        }>) => {
            if (input.binding.id === 'group-retired') return Promise.reject(lifecycleError);
            return Promise.resolve(input.label.content.v === 'first label' ? 'First Group' : 'Second Group');
        });
        const first = [group('group-visible', 'first label')];
        const second = [
            group('group-retired', 'retired label'),
            group('group-visible', 'second label'),
        ];
        const hook = await renderHook(({ groups }) => useTeamGroupDisplayNames({
            scope: { serverId: 'server-1', accountId: 'account-1' },
            groups,
        }), { initialProps: { groups: first } });

        await vi.waitFor(() => {
            expect([...hook.getCurrent()]).toEqual([['group-visible', 'First Group']]);
        });

        hook.rerender({ groups: second });

        await vi.waitFor(() => {
            expect(isPrivateLabelLifecycleFailureV1).toHaveBeenCalledWith(lifecycleError, expect.any(AbortSignal));
        });
        expect([...hook.getCurrent()]).toEqual([
            ['group-retired', null],
            ['group-visible', null],
        ]);
    });

});
