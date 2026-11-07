import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { computerScopeKey } from '@/sync/domains/computer/computerControlClient';
import { RemoteViewerStage, type RemoteViewerStageControls } from './RemoteViewerStage';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

describe('remote viewer stage', () => {
    it('remembers the mode across remounts and isolates Home, Account, Machine, Session and machine-person viewers', async () => {
        let controls!: RemoteViewerStageControls;
        const scope = {serverId: 'mode-home-a', machineId: 'machine-a', sessionId: 'session-a'};
        const key = (account: string, source: Parameters<typeof computerScopeKey>[0]) => JSON.stringify([account, computerScopeKey(source)]);
        const first = key('account-a', scope);
        const render = (viewerKey: string) => <RemoteViewerStage viewerKey={viewerKey} enabled={false} viewport={{width: 800, height: 400}}
            testID="stage" renderInput={value => { controls = value; return null; }}>{null}</RemoteViewerStage>;
        let screen = await renderScreen(render(first));
        await act(async () => controls.setMode('trackpad'));
        expect(controls.mode).toBe('trackpad');
        await screen.unmount();
        screen = await renderScreen(render(first));
        expect(controls.mode).toBe('trackpad');
        for (const other of [key('account-b', scope), key('account-a', {...scope, serverId: 'mode-home-b'}),
            key('account-a', {...scope, machineId: 'machine-b'}), key('account-a', {...scope, sessionId: 'session-b'}),
            key('account-a', {serverId: scope.serverId, machineId: scope.machineId, source: {kind: 'machine-person', personId: 'person-a'}})]) {
            await screen.update(render(other));
            expect(controls.mode).toBe('direct');
        }
        await screen.update(render(first));
        expect(controls.mode).toBe('trackpad');
        await act(async () => controls.setMode('direct'));
        await screen.unmount();
    });

});
