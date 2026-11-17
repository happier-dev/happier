import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScmPullRequestListResponseSchema } from '@happier-dev/protocol/scm/pullRequests';

import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { storage } from '@/sync/domains/state/storage';
import { SessionTriggerPullRequestPicker } from './SessionTriggerPullRequestPicker';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { ServerScopedMachineRpcParams } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';

const machineRpc = vi.hoisted(() => vi.fn());
// Machine RPC is the network boundary. SCM targeting, response parsing and dropdown stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

afterEach(() => machineRpc.mockReset());

describe('SessionTriggerPullRequestPicker', () => {
    it('lists the explicitly mounted Home repository when another Home has the same Session id', async () => {
        const previous = storage.getState();
        const focused = createSessionFixture({ id: 'same-pr-session', serverId: 'focused-pr-home' });
        const mounted = createSessionFixture({ id: focused.id, serverId: 'mounted-pr-home',
            metadata: { ...focused.metadata!, machineId: 'mounted-machine', path: '/mounted-repository' } });
        storage.setState({ sessions: { [focused.id]: focused }, sessionListRowsByServerId: {
            'mounted-pr-home': { [mounted.id]: buildSessionListRenderableFromSession(mounted) },
        } });
        machineRpc.mockImplementation(async ({ payload }: ServerScopedMachineRpcParams<{ cwd: string }>) =>
            ScmPullRequestListResponseSchema.parse({ success: true, pullRequests: [{
                provider: { kind: 'github', id: 'github', displayName: 'GitHub', baseUrl: 'https://github.com',
                    nameWithOwner: payload.cwd === '/mounted-repository' ? 'mounted/repository' : 'focused/repository' },
                number: 42, title: 'Selected Home change', url: 'https://github.com/mounted/repository/pull/42',
                baseBranch: 'main', headBranch: 'fix', state: 'open',
            }] }));
        const screen = await renderScreen(<SessionTriggerPullRequestPicker testID="mounted-pr-picker"
            sessionId={mounted.id} serverId="mounted-pr-home" selection={null} onSelect={() => {}} />);
        try {
            expect(machineRpc).not.toHaveBeenCalled();
            await act(async () => screen.findByType(DropdownMenu).props.onOpenChange(true));
            expect(screen.findByType(DropdownMenu).props.items).toEqual([
                expect.objectContaining({ id: 'mounted/repository#42' }),
            ]);
        } finally {
            await screen.unmount();
            storage.setState(previous);
        }
    });

    it('lists the session repository on demand, selects repository plus number, and retains a closed selected PR', async () => {
        const previous = storage.getState();
        const session = createSessionFixture({ id: 'pr-picker-session' });
        storage.setState({ sessions: { [session.id]: session } });
        const onSelect = vi.fn();
        machineRpc.mockResolvedValue(ScmPullRequestListResponseSchema.parse({ success: true, pullRequests: [{
            provider: { kind: 'github', id: 'github', displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: 'happier-dev/happier' },
            number: 42, title: 'Fix CI', url: 'https://github.com/happier-dev/happier/pull/42',
            baseBranch: 'main', headBranch: 'fix', state: 'open',
        }] }));
        try {
            const screen = await renderScreen(<SessionTriggerPullRequestPicker testID="pr-picker" sessionId={session.id}
                selection={{ repository: 'happier-dev/happier', number: 41 }} onSelect={onSelect} />);
            expect(machineRpc).not.toHaveBeenCalled();
            expect(screen.getTextContent()).toContain('#41');
            await act(async () => screen.findByType(DropdownMenu).props.onOpenChange(true));
            const dropdown = screen.findByType(DropdownMenu);
            expect(dropdown.props.items).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'happier-dev/happier#41' }),
                expect.objectContaining({ id: 'happier-dev/happier#42', subtitle: 'happier-dev/happier' }),
            ]));
            await act(async () => dropdown.props.onSelect('happier-dev/happier#42'));
            expect(onSelect).toHaveBeenCalledWith({ repository: 'happier-dev/happier', number: 42 });
            expect(screen.findByType(DropdownMenu).props.open).toBe(false);
        } finally { storage.setState(previous); }
    });
});
