import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createUnavailableRuntimeActionExecutor } from '@happier-dev/protocol/actions/executor/dispatch';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox, installOwnMachineApprovalReplayBoundary } from '@/dev/testkit/harness/approvalInbox';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
// The native renderer, network and daemon RPC are boundaries; Account admission,
// Action policy, approval Artifact lifecycle and mounted continuation remain real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: boundary.rpc }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { useComputerSessionControl } = await import('./useComputerSessionControl');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { createComputerRuntimeActionExecutor } = await import('@/sync/domains/computer/actions/runtimeActionExecutor');

describe('mounted Computer recovery through configurable Action approval', () => {
    beforeEach(async () => { await harness.reset(); boundary.rpc.mockReset(); });
    afterEach(() => standardCleanup());

    it('keeps rejected unknown input quarantined, then resumes an approved retry in the captured Session', async () => {
        const serverId = await harness.addHome({ name: 'Computer Home', serverUrl: 'https://computer-recovery.test',
            serverIdentityId: 'srv_computer_recovery', accountId: 'alice', currentAccount: true });
        const accountScope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'alice' };
        const settings = { actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
            actions: { 'computer.target.select': { approvalRequiredSurfaces: ['ui'] } },
            approvalWaivedSurfaces: { 'computer.capture': ['ui'] } }) };
        storage.setState({ settingsScope: accountScope, profileScope: accountScope, settings: { ...storage.getState().settings, ...settings } });
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected admitted Computer Account');
        const target = { kind: 'window', displayId: ':77', pid: 123, windowId: 456 } as const;
        let sourceId = 'computer:uncertain';
        let uncertain = true;
        const calls: Array<{ actionId: string; sessionId: string; input: unknown }> = [];
        const selected = () => ({ consentGranted: true, selectedTarget: target, sourceId, access: 'use' as const,
            approvalDisplay: { machineDisplayName: 'Studio', requiresTargetSelection: false, target: { kind: 'window', title: 'Editor' } } });
        boundary.rpc.mockImplementation(async (request: { method: string; payload: { actionId: string; sessionId: string; input: unknown } }) => {
            expect(request.method).toBe(RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE);
            const { actionId, sessionId, input } = request.payload;
            calls.push({ actionId, sessionId, input });
            let result: unknown;
            if (actionId === 'computer.target.get') result = selected();
            else if (actionId === 'computer.targets.list') result = { targets: [{ target }], grants: { capture: 'granted', input: 'granted' } };
            else if (actionId === 'computer.control.status') result = { target, sourceId, controller: 'human', controlEpoch: 2, stopping: false, uncertain, grants: { capture: 'granted', input: 'granted' } };
            else if (actionId === 'computer.target.select') { sourceId = 'computer:fresh'; result = selected(); }
            else if (actionId === 'computer.capture') {
                expect(input).toMatchObject({ target, sourceId: 'computer:fresh' });
                uncertain = false;
                result = { target, sourceId, status: 'captured', captureId: 'capture_2',
                    geometry: { captureWidth: 10, captureHeight: 10, nativeWidth: 10, nativeHeight: 10, originX: 0, originY: 0, scaleX: 1, scaleY: 1, crop: { x: 0, y: 0, width: 10, height: 10 } },
                    media: { mediaId: 'm', mediaKind: 'image', width: 10, height: 10, sizeBytes: 1,
                        file: { sessionId: 'captured-session', storage: 'daemon', path: 'p.png', sha256: 'a'.repeat(64), mimeType: 'image/png' } } };
            } else throw new Error(`Unexpected Computer effect: ${actionId}`);
            return { protocolVersion: 1, result };
        });
        await installOwnMachineApprovalReplayBoundary({ harness, serverId, accountId: 'alice', machineId: 'machine',
            runtimeActionExecute: createComputerRuntimeActionExecutor({ fallback: createUnavailableRuntimeActionExecutor(), accountLifetime: lifetime }) });
        const hook = await renderHook(() => ({ binding: useServerCredentialAccountScopeBinding(serverId), control: useComputerSessionControl({
            scope: { serverId, sessionId: 'captured-session', machineId: 'machine' }, accountLifetime: lifetime,
        }) }));
        try {
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(hook.getCurrent().binding.binding?.isCurrent()).toBe(true);
                expect(hook.getCurrent().control.selection?.sourceId).toBe('computer:uncertain');
                expect(hook.getCurrent().control.presence.kind).toBe('unconfirmed');
            });
            await act(async () => hook.getCurrent().control.checkAgain());
            expect({ busy: hook.getCurrent().control.busy, failure: hook.getCurrent().control.failure }).toEqual({ busy: 'check', failure: null });
            expect(calls.some(call => call.actionId === 'computer.capture' || call.actionId === 'computer.target.select')).toBe(false);
            const first = await waitForHomeGovernance(() => {
                const artifact = harness.artifacts(serverId).list()[0]; expect(artifact).toBeDefined(); return artifact!;
            });
            const request = ApprovalRequestSchema.parse(JSON.parse(harness.artifacts(serverId).readPlainBody(first.id) ?? 'null'));
            expect(request).toMatchObject({ actionId: 'computer.target.select', status: 'open', actionArgs: { machineId: 'machine', target, access: 'use' } });
            expect(await decideApprovalAsInbox(serverId, first.id, 'reject')).toMatchObject({ ok: true });
            await waitForHomeGovernance(() => expect(hook.getCurrent().control.busy).toBeNull());
            expect(hook.getCurrent().control.canInput).toBe(false);
            expect(hook.getCurrent().control.selection?.sourceId).toBe('computer:uncertain');
            expect(hook.getCurrent().control.presence.kind).toBe('unconfirmed');
            expect(calls.some(call => call.actionId === 'computer.capture')).toBe(false);

            await act(async () => hook.getCurrent().control.checkAgain());
            const retry = await waitForHomeGovernance(() => {
                const artifact = harness.artifacts(serverId).list().find(artifact => artifact.id !== first.id); expect(artifact).toBeDefined(); return artifact!;
            });
            expect(await decideApprovalAsInbox(serverId, retry.id, 'approve')).toMatchObject({
                ok: true, result: { status: 'executed', execution: { ok: true } },
            });
            await waitForHomeGovernance(() => { expect(hook.getCurrent().control.busy).toBeNull(); expect(hook.getCurrent().control.canInput).toBe(true); });
            expect(hook.getCurrent().control.selection?.sourceId).toBe('computer:fresh');
            expect(calls.filter(call => call.actionId === 'computer.target.select' || call.actionId === 'computer.capture').map(call => call.actionId)).toEqual(['computer.target.select', 'computer.capture']);
            expect(calls.every(call => call.sessionId === 'captured-session')).toBe(true);
        } finally { await hook.unmount(); }
    });
});
