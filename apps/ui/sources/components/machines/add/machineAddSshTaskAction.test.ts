import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createDeferred } from '@/dev/testkit';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
vi.mock('@/config', () => ({ config: { variant: 'production', identityVariant: 'stable' } }));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const { storage } = await import('@/sync/domains/state/storageStore');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { readMachineAddFlowDraft, updateMachineAddFlowDraft, discardMachineAddFlowDraft } = await import('./machineAddFlowStore');
const { createManualSystemTaskRunner } = await import('@/dev/testkit/harness/manualSystemTaskRunner');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { createAccountSettingsScope } = await import('@/sync/domains/settings/scope/accountSettingsScope');
const { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
// Load the real Action graph after its transport boundaries, during collection rather than a timed behavior case.
const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
const { normalizeActionsSettingsV1 } = await import('@happier-dev/protocol/actions/actionSettings');
const { createMachineAddSshTaskAction } = await import('./machineAddSshTaskAction');
const { Modal } = await import('@/modal');
const sshPolicy = { v: 1 as const, actions: {}, approvalWaivedSurfaces: {
    'machines.add.ssh.start': ['ui' as const], 'machines.add.ssh.respond': ['ui' as const] } };

async function admitSsh(serverId: string, accountId: string) {
    const scope = createAccountSettingsScope(serverId, accountId);
    if (!scope) throw new Error('Invalid SSH fixture Account scope');
    await storage.getState().activateSettingsScope(scope);
    storage.getState().activateProfileScope(scope);
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1: sshPolicy } }, version: 1 } });
    storage.setState({ settingsScope: scope, profileScope: scope,
        settings: { ...storage.getState().settings, actionsSettingsV1: sshPolicy }, machineListByServerId: { [serverId]: [] } });
}
beforeEach(async () => { await harness.reset(); });
afterEach(() => { discardMachineAddFlowDraft(); publishAppliedActiveServerRuntimeAvailability(false); standardCleanup(); });
describe('standalone SSH enrollment Actions', () => {
    it('keeps immutable draft identity across an in-place public draft edit and desktop continuation', async () => {
        const previous = storage.getState();
        const serverId = await harness.addHome({ serverUrl: 'https://immutable-identity.example.test', name: 'Immutable identity', accountId: 'alice' });
        const manual = createManualSystemTaskRunner('tauri');
        vi.stubGlobal('isTauri', true);
        try {
            await setActiveServerId(serverId);
            await admitSsh(serverId, 'alice');
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({ machineAddSshTaskAction: createMachineAddSshTaskAction(manual.runner) }));
            const context = { surface: 'ui', authority: 'present_user', serverId, actionsSettings: normalizeActionsSettingsV1(sshPolicy) } as const;
            const enrollmentIdentity = { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server',
                adminAccessAtCreation: 'ask', administrator: { username: 'operator' } } as const;
            expect(await executor.execute('machines.add.ssh.start', { serverId, host: 'server', username: 'root', authMode: 'keyfile',
                identityFilePath: '/keys/setup', enrollmentIdentity }, context)).toEqual({ ok: true, result: { taskId: 'personal-home-task-1' } });
            const editableIdentity = readMachineAddFlowDraft().sshDraft.enrollmentIdentity;
            if (editableIdentity?.kind !== 'dedicatedDaemonUser' || !editableIdentity.administrator) throw new Error('Expected reviewed public draft');
            editableIdentity.administrator.username = 'another-operator';
            manual.emitEvent('personal-home-task-1', { type: 'prompt', message: 'Approve enrollment', data: { kind: 'auth.approveRemoteProvisioning', publicKey: 'key' } });
            manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: false,
                error: { code: 'auth_required', message: 'Approval required' } });
            expect(await executor.execute('machines.add.ssh.respond', { taskId: 'personal-home-task-1',
                answer: { kind: 'auth.approveRemoteProvisioning', approved: true } }, context)).toEqual({ ok: true, result: { taskId: 'personal-home-task-2' } });
            expect(manual.bridge.start.mock.calls.at(-1)?.[0]).toMatchObject({ params: { enrollmentIdentity } });
            expect(readMachineAddFlowDraft().sshTask?.sshSubmission?.draft.enrollmentIdentity).toEqual(enrollmentIdentity);
        } finally { discardMachineAddFlowDraft(); storage.setState(previous); vi.unstubAllGlobals(); }
    });

    it('retires aborted establishment without delivering its password and obtains a fresh answer from the same prompt', async () => {
        const previous = storage.getState();
        const serverId = await harness.addHome({ serverUrl: 'https://retired-establish.example.test', name: 'Retired establishment', accountId: 'alice' });
        const manual = createManualSystemTaskRunner('native');
        vi.stubGlobal('isTauri', true);
        try {
            await setActiveServerId(serverId);
            await admitSsh(serverId, 'alice');
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({ machineAddSshTaskAction: createMachineAddSshTaskAction(manual.runner) }));
            const context = { surface: 'ui', authority: 'present_user', serverId, actionsSettings: normalizeActionsSettingsV1(sshPolicy) } as const;
            expect(await executor.execute('machines.add.ssh.start', { serverId, host: 'server', authMode: 'keyfile', identityFilePath: '/keys/setup',
                enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server',
                    adminAccessAtCreation: 'ask', administrator: { username: 'operator' } } }, context))
                .toEqual({ ok: true, result: { taskId: 'personal-home-task-1' } });
            manual.emitEvent('personal-home-task-1', { type: 'prompt', message: 'Establish administrator', data: {
                kind: 'administrator.establish', promptId: 'establish-current', administratorUsername: 'operator' } });
            const response = { taskId: 'personal-home-task-1', answer: { kind: 'administrator.establish', promptId: 'establish-current' } };
            const entered = createDeferred<void>();
            const password = createDeferred<string | null>();
            vi.mocked(Modal.prompt).mockImplementationOnce(() => { entered.resolve(); return password.promise; });
            const invocation = new AbortController();
            const pending = executor.execute('machines.add.ssh.respond', response, { ...context, signal: invocation.signal });
            await entered.promise;
            invocation.abort();
            password.resolve('fixture-aborted-password');
            expect(await pending).toMatchObject({ ok: false, errorCode: 'continuation_retired' });
            expect(manual.bridge.respond).not.toHaveBeenCalled();
            expect(manual.runner.getSnapshot('personal-home-task-1')?.cancelRequested).toBe(false);
            vi.mocked(Modal.prompt).mockResolvedValueOnce('fixture-current-password');
            expect(await executor.execute('machines.add.ssh.respond', response, context)).toEqual({ ok: true, result: { taskId: 'personal-home-task-1' } });
            expect(manual.bridge.respond).toHaveBeenLastCalledWith('personal-home-task-1', { password: 'fixture-current-password' });
        } finally { discardMachineAddFlowDraft(); storage.setState(previous); vi.unstubAllGlobals(); }
    });

    it.each(['native', 'tauri'] as const)('captures standalone dedicated identity through the public SSH Action and %s continuation', async mode => {
        const previous = storage.getState();
        const serverId = await harness.addHome({ serverUrl: `https://identity-${mode}.example.test`, name: 'Identity', accountId: 'alice' });
        const manual = createManualSystemTaskRunner(mode);
        vi.stubGlobal('isTauri', true);
        try {
            await setActiveServerId(serverId);
            await admitSsh(serverId, 'alice');
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({ machineAddSshTaskAction: createMachineAddSshTaskAction(manual.runner) }));
            const actionsSettings = normalizeActionsSettingsV1(sshPolicy);
            const context = { surface: 'ui', authority: 'present_user', serverId, actionsSettings } as const;
            const enrollmentIdentity = { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'none' } as const;
            const start = await executor.execute('machines.add.ssh.start', { serverId, host: 'server', username: 'root', authMode: 'keyfile', identityFilePath: '/keys/setup', enrollmentIdentity }, context);
            expect(start).toEqual({ ok: true, result: { taskId: 'personal-home-task-1' } });
            expect(manual.bridge.start.mock.calls[0]?.[0]).toMatchObject({ kind: 'remote.ssh.bootstrapMachine.v1', params: { enrollmentIdentity } });
            updateMachineAddFlowDraft(draft => ({ ...draft, sshDraft: { ...draft.sshDraft,
                enrollmentIdentity: { kind: 'existingUser', role: 'personal' } } }));
            manual.emitEvent('personal-home-task-1', { type: 'prompt', message: 'Approve enrollment', data: { kind: 'auth.approveRemoteProvisioning', publicKey: 'key' } });
            if (mode === 'tauri') manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: false, error: { code: 'auth_required', message: 'Approval required' } });
            const continued = await executor.execute('machines.add.ssh.respond', { taskId: 'personal-home-task-1', answer: { kind: 'auth.approveRemoteProvisioning', approved: true } }, context);
            expect(continued).toEqual({ ok: true, result: { taskId: mode === 'native' ? 'personal-home-task-1' : 'personal-home-task-2' } });
            expect(readMachineAddFlowDraft().sshTask?.sshSubmission?.draft.enrollmentIdentity).toEqual(enrollmentIdentity);
            expect(manual.bridge.start.mock.calls.at(-1)?.[0]).toMatchObject({ params: { enrollmentIdentity } });
        } finally { discardMachineAddFlowDraft(); storage.setState(previous); vi.unstubAllGlobals(); }
    });

    it('uses unavailable presentation refusal before SSH and answers establishment only through the transient secure prompt', async () => {
        const previous = storage.getState();
        const serverId = await harness.addHome({ serverUrl: 'https://ask-identity.example.test', name: 'Ask identity', accountId: 'alice' });
        const manual = createManualSystemTaskRunner('native');
        vi.stubGlobal('isTauri', true);
        try {
            await setActiveServerId(serverId);
            await admitSsh(serverId, 'alice');
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({ machineAddSshTaskAction: createMachineAddSshTaskAction(manual.runner) }));
            const actionsSettings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
                'machines.add.ssh.start': ['ui', 'agent'], 'machines.add.ssh.respond': ['ui', 'agent'], 'machines.add.ssh.status': ['ui'] } });
            const user = { surface: 'ui', authority: 'present_user', serverId, actionsSettings } as const;
            const unattended = { surface: 'agent', authority: 'account_automation', interactivePresentation: 'unavailable', serverId, actionsSettings } as const;
            const enrollmentIdentity = { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server',
                adminAccessAtCreation: 'ask', administrator: { username: 'operator' } } as const;
            const input = { serverId, host: 'server', username: 'root', authMode: 'keyfile', identityFilePath: '/keys/setup', enrollmentIdentity };
            expect(await executor.execute('machines.add.ssh.start', input, unattended)).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
            expect(manual.bridge.start).not.toHaveBeenCalled();
            expect(await executor.execute('machines.add.ssh.start', { ...input, enrollmentIdentity: { ...enrollmentIdentity, administrator: { username: 'root' } } }, user))
                .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
            expect(manual.bridge.start).not.toHaveBeenCalled();
            expect(await executor.execute('machines.add.ssh.start', input, user)).toEqual({ ok: true, result: { taskId: 'personal-home-task-1' } });
            manual.emitEvent('personal-home-task-1', { type: 'prompt', message: 'Establish administrator', data: { kind: 'administrator.establish', promptId: 'establish-1', administratorUsername: 'operator' } });
            const answer = { taskId: 'personal-home-task-1', answer: { kind: 'administrator.establish', promptId: 'establish-1' } };
            expect(await executor.execute('machines.add.ssh.respond', answer, unattended)).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
            expect(await executor.execute('machines.add.ssh.respond', { ...answer, answer: { ...answer.answer, promptId: 'foreign-prompt' } }, user))
                .toMatchObject({ ok: false, errorCode: 'no_prompt' });
            expect(manual.bridge.respond).not.toHaveBeenCalled();
            vi.mocked(Modal.prompt).mockResolvedValueOnce('fixture-administrator-password');
            expect(await executor.execute('machines.add.ssh.respond', answer, user)).toEqual({ ok: true, result: { taskId: 'personal-home-task-1' } });
            expect(manual.bridge.respond).toHaveBeenLastCalledWith('personal-home-task-1', { password: 'fixture-administrator-password' });
            expect(vi.mocked(Modal.prompt).mock.calls.at(-1)?.[2]).toMatchObject({ inputType: 'secure-text' });
            const status = await executor.execute('machines.add.ssh.status', { taskId: 'personal-home-task-1' }, user);
            expect(JSON.stringify([readMachineAddFlowDraft(), status, manual.bridge.start.mock.calls])).not.toContain('fixture-administrator-password');
            expect(status).toMatchObject({ ok: true, result: { prompt: { kind: 'administrator.establish',
                promptId: 'establish-1', administratorUsername: 'operator', requiresPresentUser: true } } });
            const pendingPassword = createDeferred<string | null>();
            const promptEntered = createDeferred<void>();
            vi.mocked(Modal.prompt).mockImplementationOnce(() => { promptEntered.resolve(); return pendingPassword.promise; });
            manual.emitEvent('personal-home-task-1', { type: 'prompt', message: 'Establish administrator', data: {
                kind: 'administrator.establish', promptId: 'establish-2', administratorUsername: 'operator' } });
            const delayed = executor.execute('machines.add.ssh.respond', { ...answer, answer: { ...answer.answer, promptId: 'establish-2' } }, user);
            await promptEntered.promise;
            manual.emitEvent('personal-home-task-1', { type: 'prompt', message: 'Establish administrator', data: {
                kind: 'administrator.establish', promptId: 'establish-3', administratorUsername: 'operator' } });
            pendingPassword.resolve('fixture-retired-password');
            expect(await delayed).toMatchObject({ ok: false, errorCode: 'continuation_retired' });
            expect(manual.bridge.respond).not.toHaveBeenCalledWith('personal-home-task-1', { password: 'fixture-retired-password' });
            vi.mocked(Modal.prompt).mockResolvedValueOnce('fixture-fresh-password');
            expect(await executor.execute('machines.add.ssh.respond', { ...answer, answer: { ...answer.answer, promptId: 'establish-3' } }, user))
                .toEqual({ ok: true, result: { taskId: 'personal-home-task-1' } });
            expect(manual.bridge.respond).toHaveBeenLastCalledWith('personal-home-task-1', { password: 'fixture-fresh-password' });
            expect(JSON.stringify([readMachineAddFlowDraft(), manual.runner.getSnapshot('personal-home-task-1')])).not.toContain('fixture-fresh-password');
        } finally { discardMachineAddFlowDraft(); storage.setState(previous); vi.unstubAllGlobals(); }
    });

    it('keeps omitted identity personal even when another reviewed identity remains in the draft', async () => {
        const previous = storage.getState();
        const serverId = await harness.addHome({ serverUrl: 'https://personal-identity.example.test', name: 'Personal', accountId: 'alice' });
        const manual = createManualSystemTaskRunner('native');
        vi.stubGlobal('isTauri', true);
        try {
            await setActiveServerId(serverId);
            await admitSsh(serverId, 'alice');
            updateMachineAddFlowDraft(draft => ({ ...draft, serverId, sshDraft: { ...draft.sshDraft, host: 'personal', authMode: 'keyfile',
                enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'none' } } }));
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({ machineAddSshTaskAction: createMachineAddSshTaskAction(manual.runner) }));
            expect(await executor.execute('machines.add.ssh.start', { serverId, host: 'personal', authMode: 'keyfile' }, {
                surface: 'ui', authority: 'present_user', serverId, actionsSettings: normalizeActionsSettingsV1(sshPolicy),
            })).toEqual({ ok: true, result: { taskId: 'personal-home-task-1' } });
            expect(manual.bridge.start.mock.calls[0]?.[0].params).not.toHaveProperty('enrollmentIdentity');
            expect(readMachineAddFlowDraft().sshTask?.sshSubmission?.draft.enrollmentIdentity).toBeUndefined();
        } finally { discardMachineAddFlowDraft(); storage.setState(previous); vi.unstubAllGlobals(); }
    });

});

