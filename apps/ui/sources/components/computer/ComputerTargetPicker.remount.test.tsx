import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
// Only native rendering/dialog presentation, network and daemon RPC are boundaries.
// The picker, whole-display consent, credential lifetime and Action front door remain real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: boundary.rpc }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { SessionViewerDestinationScope, useSessionViewerDestinationScope } = await import('@/components/sessions/viewer/SessionViewerDestinationScope');
const { useComputerTargetPicker } = await import('./useComputerTargetPicker');
const { ComputerTargetPicker } = await import('./ComputerTargetPicker');
const { computerTargetKeyV1 } = await import('@happier-dev/protocol/computer/v1');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');

describe('Computer target picker across Session shell replacement', () => {
    beforeEach(async () => { await harness.reset(); boundary.rpc.mockReset(); });
    afterEach(() => standardCleanup());

    it('finishes whole-display consent while the Session shell remounts, without retiring or relisting the pending picker', async () => {
        const serverId = await harness.addHome({ name: 'Computer Home', serverUrl: 'https://computer-resize.test', accountId: 'alice' });
        const accountScope = { serverId, accountId: 'alice' };
        const settings = { actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {},
            approvalWaivedSurfaces: { 'computer.target.select': ['ui'] } }) };
        storage.setState({ settingsScope: accountScope, profileScope: accountScope, settings: { ...storage.getState().settings, ...settings } });
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const target = { kind: 'display', displayId: ':77' } as const;
        const selected = { consentGranted: false, selectedTarget: target, sourceId: 'computer:resized', access: 'use',
            approvalDisplay: { machineDisplayName: 'Studio', requiresTargetSelection: false, access: 'use', target: { kind: 'display', title: 'Display' } } } as const;
        const selection = createDeferred<typeof selected>();
        const calls: string[] = [];
        boundary.rpc.mockImplementation(async (request: { payload: { actionId: string } }) => {
            const { actionId } = request.payload;
            calls.push(actionId);
            if (actionId === 'computer.targets.list') return { protocolVersion: 1, result: {
                targets: [{ target }], grants: { capture: 'granted', input: 'granted' },
            } };
            if (actionId === 'computer.target.get') return { protocolVersion: 1, result: selected };
            if (actionId === 'computer.target.select') {
                return { protocolVersion: 1, result: await selection.promise };
            }
            throw new Error(`Unexpected Computer effect: ${actionId}`);
        });
        const onSelected = vi.fn();
        const onClose = vi.fn();
        function Shell() {
            useServerCredentialAccountScopeBinding(serverId);
            return null;
        }
        function Picker() {
            const destination = useSessionViewerDestinationScope('resize-session', serverId);
            const picker = useComputerTargetPicker({ scope: { serverId, sessionId: 'resize-session', machineId: 'machine' },
                execute: frontDoor, accountLifetime: destination?.accountLifetime ?? null,
                currentTargetKey: computerTargetKeyV1(target), onSelected, onClose });
            return <ComputerTargetPicker machineName="Studio" agentName="Claude" state={picker.state}
                policy={{ asksBeforeScreenshots: true, asksBeforeInput: true }}
                selectedKey={picker.selectedKey} onSelect={picker.setSelectedKey} access={picker.access} onAccessChange={picker.setAccess}
                sharing={picker.sharing} noticeCode={picker.noticeCode} canStopSharing={false} onShare={picker.share}
                onStopSharing={picker.stopSharing} onCancel={onClose} onRetry={picker.retry}
                onOpenSettings={picker.requestSettings} openSettings={picker.openSettings} />;
        }
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const frontDoor = createFrontDoorActionExecute();
        const credentials = await TokenStorage.getCredentials();
        if (!credentials) throw new Error('Expected the harness Account credentials');
        // FX-16's real destination now owns Board recovery too; match the Auth
        // ancestor supplied by the application shell instead of stubbing Board.
        const tree = (shell: string) => <InjectedAuthProvider credentials={credentials}>
            <SessionViewerDestinationScope sessionId="resize-session" serverId={serverId}>
                <Shell key={shell} /><Picker />
            </SessionViewerDestinationScope>
        </InjectedAuthProvider>;
        const screen = await renderScreen(tree('wide'));
        try {
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('computer-target-picker-ready')).not.toBeNull());
            await screen.pressByTestIdAsync('computer-target-picker-share');
            await screen.pressByTestIdAsync('computer-target-picker-display-consent-share');
            await waitForHomeGovernance(() => expect(calls).toContain('computer.target.select'));
            await screen.update(tree('phone'));
            await screen.update(tree('wide-return'));
            await act(async () => { selection.resolve(selected); });
            await waitForHomeGovernance(() => expect(onSelected).toHaveBeenCalledWith(selected));
            expect(onClose).toHaveBeenCalledTimes(1);
            expect(screen.findHostByTestId('computer-target-picker-failed')).toBeNull();
            expect(calls.filter(actionId => actionId !== 'computer.target.get')).toEqual(['computer.targets.list', 'computer.target.select']);
        } finally { selection.resolve(selected); await screen.unmount(); }
    });
});
