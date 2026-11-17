import { expect, it } from 'vitest';
import { createExecutionRunNativeOperationOwner } from './executionRunNativeOperation';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createFirstConversationAgentFixture } from '@/daemon/testkit/firstConversationAgent.testkit';
import { admitAgentNativeMcpPlacementForHost } from '@/plugins/runtime/invocation/services/exec';

it('retains admitted requester custody through real native Run services when OS isolation is disabled', async () => {
    const lifetime = new AbortController();
    const requester = { kind: 'isolated' as const, separationRequired: false, accountAutomation: true as const,
        requester: { serverId: 'home', accountId: 'workflow-owner', machineId: 'machine', installationId: 'installation' } };
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
        plugins: [createFirstConversationAgentFixture('morning-digest')],
    });
    const owner = createExecutionRunNativeOperationOwner({ ingress: { signal: lifetime.signal },
        agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
        resolveRequesterIdentity: async () => requester,
        machine: {
            async readMemberFolderOwner() { throw new Error('Disabled isolation does not select an OS identity'); },
            async prepareNativeOperation() { throw new Error('Disabled isolation does not prepare OS material'); },
        },
    });
    try {
        const lease = [...fixture.registry.agentRuntimesByAgentId.values()].find(candidate => candidate.pluginId === 'acme.project-launch');
        if (!lease) throw new Error('Authored Agent was not admitted');
        const nativeOperation = await owner.prepareNativeOperation(fixture.happyHomeDir, lifetime.signal, 'morning-digest');
        const services = await fixture.registry.createAgentInvocationServices({ pluginId: lease.pluginId,
            pluginVersion: lease.pluginVersion, agentId: lease.agentId, occurrenceId: lease.occurrenceId,
            correlationId: 'morning-digest', cwd: fixture.happyHomeDir, signal: lifetime.signal,
            processOwner: { kind: 'run', runId: 'morning-digest' }, isOccurrenceCurrent: lease.isCurrent,
            ...(nativeOperation ? { nativeOperation } : {}),
        });
        const placement = await admitAgentNativeMcpPlacementForHost(services.exec, lifetime.signal);
        expect(placement?.kind).toBe('direct');
        expect(placement?.nativeAdmission.requesterIdentity).toEqual({ kind: 'isolated', separationRequired: false,
            requester: requester.requester });
        expect(placement?.nativeAdmission.read()?.enabled).toBe(false);
    } finally {
        await owner.disposeNativeOperation();
        await fixture.dispose();
    }
});

it('prepares canonical Agent placement for an unrestricted requester outside a member folder', async () => {
    const lifetime = new AbortController();
    const requester = { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' };
    const selected = { kind: 'isolated' as const, requester, separationRequired: false };
    const isolation = { read: () => ({ enabled: true, status: { kind: 'effective' as const, platform: 'linux' as const }, workspaceRoots: [] }) };
    const owner = createExecutionRunNativeOperationOwner({ ingress: { signal: lifetime.signal }, agentIsolation: isolation,
        resolveRequesterIdentity: async () => ({ kind: 'owner_person', requester }),
        // OS native material is the boundary. A nonmember project still uses
        // the Machine's canonical Agent placement; person authority is not a bypass.
        machine: { readMemberFolderOwner: async () => null,
            async prepareNativeOperation(input) {
                expect(input.requesterIdentity).toEqual(selected);
                return { requesterIdentity: selected, memberIdentity: undefined, workingDirectory: '/agent/home',
                    agentIsolation: isolation, materialTarget: { runtimeHome: '/agent/home/run' }, async dispose() {} };
            } },
    });
    try {
        const operation = await owner.prepareNativeOperation('/project', lifetime.signal, 'owner-run');
        expect(operation?.requesterIdentity).toEqual(selected);
        expect(operation?.agentIsolation.read()?.enabled).toBe(true);
    } finally { await owner.disposeNativeOperation(); }
});

it('cancels a pending native preparation with the containing start and refuses reuse after disposal', async () => {
    const caller = new AbortController();
    const identity = { kind: 'isolated' as const, separationRequired: true,
        requester: { serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' } };
    let began!: () => void;
    let nativeSignal: AbortSignal | undefined;
    const entered = new Promise<void>(resolve => { began = resolve; });
    const owner = createExecutionRunNativeOperationOwner({
        ingress: { signal: caller.signal },
        agentIsolation: { read: () => ({ enabled: true, status: { kind: 'effective', platform: 'linux' }, workspaceRoots: [] }) },
        resolveRequesterIdentity: async () => identity,
        // Native preparation is an OS boundary. Hold it until the containing
        // operation cancels; there is no fixture timer or synthetic deadline.
        machine: { readMemberFolderOwner: async () => identity,
            prepareNativeOperation: async ({ signal }) => {
                nativeSignal = signal;
                began();
                return await new Promise<never>((_resolve, reject) => {
                    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
                });
            } },
    });
    const preparing = owner.prepareNativeOperation('/member/workspace', caller.signal, 'run');
    const observed = preparing.catch(error => error);
    await entered;
    const reason = new Error('Containing Run start cancelled');
    caller.abort(reason);
    // Inspect the signal at the genuine pending boundary, so a missing relay
    // fails immediately rather than hanging the test waiting for its promise.
    expect(nativeSignal?.aborted).toBe(true);
    expect(await observed).toBe(reason);
    await owner.disposeNativeOperation().catch(() => undefined);
    expect(() => owner.prepareNativeOperation('/member/workspace', new AbortController().signal, 'late')).toThrow();
});
