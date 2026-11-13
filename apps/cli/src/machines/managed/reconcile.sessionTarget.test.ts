import { describe, expect, it } from 'vitest';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { fixture, roleResult } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import type { ManagedMachineAcquisitionDriverInput } from './acquire';
import { createManagedNativeInvocation } from './reconcile';
import { createManagedMachineAcquisitionDriver } from './acquire';

/**
 * A Session placed in a managed target: the already-admitted Session spawn is the
 * authority for that target's channel roles, through the one managed-invocation
 * owner (real custody check and contributed-Action dispatch; the plugin's role
 * handlers are the fixture's native boundary).
 */
const homeId = 'srv_session_target';
const machine = ManagedMachineV1Schema.parse({ id: 'managed-target', homeId, custodianAccountId: 'owner',
    controller: { machineId: 'controller-1', installationId: 'installation-1' },
    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Target', choices: {} },
    enrollmentIdentity: { kind: 'existingUser', role: 'adopted' }, allocation: 'bound', creationState: 'active',
    resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { guest: 'a' } },
    desired: 'start', desiredWhen: 'now', intentRevision: 3, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
});

const own = { guest: 'a' };

/** A fixture guest answering the holder bootstrap's commands (platform probe; holder files already present). */
function guestExec(input: unknown) {
    const { argv, inputBase64 } = input as { argv?: string[]; inputBase64?: string };
    const command = inputBase64 ? Buffer.from(inputBase64, 'base64').toString() : String(argv?.at(-1) ?? '');
    const stdout = command.includes('uname -s') ? 'Linux\naarch64\n/home/u\n'
        : command.includes('sha256sum') ? `${'a'.repeat(64)}  happier-session-holder\n${'b'.repeat(64)}  happier-process-custody\n` : '';
    return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdoutBase64: Buffer.from(stdout).toString('base64'), stderrBase64: '', stdoutTruncated: false, stderrTruncated: false };
}

function harness(options: Readonly<{ streamRole?: boolean; holdStream?: boolean; guest?: boolean }> = {}) {
    const calls: string[] = [];
    const inputs: unknown[] = [];
    const native = fixture({ credentialPurposes: [], streamRole: options.streamRole ?? true,
        ...(options.guest ? { nativeRoleResults: { exec: guestExec as never } } : {}),
        async onNativeRole(role, input, context) {
            calls.push(role); inputs.push(input);
            // A held channel runs until its invocation is aborted (the provider's carrier process).
            if (role === 'stream' && options.holdStream) await new Promise(resolve => context.signal?.addEventListener('abort', resolve, { once: true }));
        } });
    const refuse = async (): Promise<never> => { throw new Error('No credential use in this fixture'); };
    const authority = createManagedProviderOperationAuthority({ materializationBaseDir: '.',
        purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
            store: { read: async () => ({ v: 1, bindings: [] }), update: refuse, subscribe: () => ({ dispose() {} }) },
            selectTarget: refuse, resolveTarget: refuse, materializeAccount: refuse, projectTargetAccounts: refuse, assertTargetAccountMaterializable: refuse,
        }), requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
        createRedactionLease: () => ({ add() {}, close() {} }),
    });
    const input: ManagedMachineAcquisitionDriverInput = { token: 'controller-token', serverUrl: 'https://home.example', homeId,
        controller: machine.controller!, credentials: { token: 'controller-token', encryption: null }, managedProviderOperationAuthority: authority,
        runtimeRegistry: native.runtimeRegistry,
        homeTarget: resolveHomeTargetFromDescriptor({ authority: 'current_connection',
            descriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: 'https://home.example', revision: 1,
                endpoints: [{ kind: 'https', url: 'https://home.example' }] } }),
    };
    return { calls, inputs, native, input };
}

describe('Session-target authority for managed provider channel roles', () => {
    it('admits exactly exec, putFile and stream for the Session\'s own target while the Session is current', async () => {
        const h = harness();
        const session = new AbortController();
        const invocation = createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: session.signal } }, () => machine);
        expect(await invocation.invoke('exec', { resource: own, argv: ['uname', '-m'] })).toEqual(roleResult('exec'));
        expect(await invocation.invoke('putFile', { resource: own, guestPath: '/h', bytesBase64: '' })).toEqual(roleResult('put-file'));
        expect(await invocation.invoke('stream', { resource: own, argv: ['holder', 'attach'] })).toEqual(roleResult('stream'));
        expect(h.calls).toEqual(['exec', 'putFile', 'stream']);

        // Least privilege: lifecycle and creation roles, and exec that would start a daemon, are refused before native IO.
        for (const role of ['power', 'destroy', 'acquire', 'bootstrap', 'rebuild', 'resize'] as const) {
            await expect(invocation.invoke(role, { resource: own })).rejects.toMatchObject({ code: 'native_intent_unsupported' });
        }
        await expect(invocation.invoke('exec', { resource: own, argv: ['true'], processConfig: { environment: { HOME: '/h', HAPPIER_HOME_DIR: '/h/.happier' },
            detachedDaemonStartArgv: ['happier', 'daemon', 'start'] } })).rejects.toMatchObject({ code: 'native_intent_unsupported' });
        expect(h.calls).toEqual(['exec', 'putFile', 'stream']);

        // Bound to the Session's lifetime: once it ends, the authority is gone.
        session.abort();
        await expect(invocation.invoke('stream', { resource: own, argv: ['holder', 'attach'] })).rejects.toBeTruthy();
        expect(h.calls).toEqual(['exec', 'putFile', 'stream']);
    });

    it('is the only extra authority: without it the same call has no admission', () => {
        const h = harness();
        expect(() => createManagedNativeInvocation({ input: h.input, options: { requestId: 'no-authority' }, machine,
            action: 'session.spawn_new' } as never, () => machine)).toThrow(expect.objectContaining({ code: 'admission_unavailable' }));
    });

    it('refuses a target controlled by another Machine', () => {
        const h = harness();
        const elsewhere = { ...machine, controller: { machineId: 'controller-2', installationId: 'installation-2' } };
        expect(() => createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine: elsewhere,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: new AbortController().signal } }, () => elsewhere))
            .toThrow(expect.objectContaining({ code: 'admission_unavailable' }));
    });

    it('binds the authority to the row\'s own guest: another resource is refused before native IO', async () => {
        const h = harness();
        const invocation = createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: new AbortController().signal } }, () => machine);
        for (const [role, body] of [['exec', { resource: { guest: 'b' }, argv: ['true'] }], ['putFile', { resource: { guest: 'b' }, guestPath: '/h', bytesBase64: '' }],
            ['stream', { resource: { guest: 'b' }, argv: ['holder', 'attach'] }], ['stream', { argv: ['holder', 'attach'] }]] as const) {
            await expect(invocation.invoke(role, body)).rejects.toMatchObject({ code: 'admission_unavailable' });
        }
        expect(h.calls).toEqual([]);
    });

    it('never wakes a stopped target: exec and putFile carry allowWake false', async () => {
        const h = harness();
        const invocation = createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: new AbortController().signal } }, () => machine);
        await invocation.invoke('exec', { resource: own, argv: ['true'] });
        await invocation.invoke('putFile', { resource: own, guestPath: '/h', bytesBase64: '' });
        expect(h.inputs).toEqual([expect.objectContaining({ allowWake: false }), expect.objectContaining({ allowWake: false })]);
    });

    it('ends a running channel when the Session ends', async () => {
        const h = harness({ holdStream: true });
        const session = new AbortController();
        const invocation = createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: session.signal } }, () => machine);
        const channel = invocation.invoke('stream', { resource: own, argv: ['holder', 'attach'] });
        const settled = channel.then(() => 'settled', () => 'settled');
        await expect.poll(() => h.calls).toEqual(['stream']);
        session.abort();
        await expect(settled).resolves.toBe('settled');
    });

    it('serves finite calls while the Session\'s Agent channel stays open (each call is its own provider operation)', async () => {
        // A placed Session holds its Agent's holder channel for its whole life; the Session-end cleanup, a second
        // Agent's holder start and the Files/Git channel all run next to it through the same authority.
        const h = harness({ holdStream: true });
        const session = new AbortController();
        const invocation = createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: session.signal } }, () => machine);
        const agentChannel = invocation.invoke('stream', { resource: own, argv: ['holder', 'attach'] }).then(() => 'settled', () => 'settled');
        await expect.poll(() => h.calls).toEqual(['stream']);
        await expect(invocation.invoke('exec', { resource: own, argv: ['rm', '-rf', '/g/.happier/sessions/s1'] })).resolves.toEqual(roleResult('exec'));
        const filesChannel = invocation.invoke('stream', { resource: own, argv: ['holder', 'attach', '--ops'] }).then(() => 'settled', () => 'settled');
        await expect.poll(() => h.calls).toEqual(['stream', 'exec', 'stream']);
        session.abort();
        await expect(Promise.all([agentChannel, filesChannel])).resolves.toEqual(['settled', 'settled']);
    });

    it('ends when the row stops being this Session\'s target (rebuilt, unbound or deleted)', async () => {
        const h = harness();
        let current = machine;
        const invocation = createManagedNativeInvocation({ input: h.input, options: { requestId: 'session-target:s1' }, machine,
            action: 'session.spawn_new', sessionTarget: { sessionId: 's1', lifetime: new AbortController().signal } }, () => current);
        for (const changed of [{ ...machine, resource: { ...machine.resource!, value: { guest: 'rebuilt' } } },
            { ...machine, controller: { ...machine.controller!, installationId: 'installation-2' } },
            { ...machine, desired: 'delete' as const }]) {
            current = changed;
            await expect(invocation.invoke('exec', { resource: own, argv: ['true'] })).rejects.toMatchObject({ code: 'admission_unavailable' });
        }
        expect(h.calls).toEqual([]);
    });
});

describe('Session placement on a managed target (driver)', () => {
    const holder = { version: 'v1', resolveArtifacts: async () => ({ holder: { bytes: new Uint8Array([1]), sha256: 'a'.repeat(64) },
        helper: { bytes: new Uint8Array([2]), sha256: 'b'.repeat(64) } }) };

    it('places a Session only for the row\'s custodian; another requester is refused before any native IO', async () => {
        const h = harness();
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readPolicyCurrent: async () => machine });
        const session = new AbortController();
        await expect(driver.openSessionTarget({ managedId: machine.id, sessionId: 's1', requesterAccountId: 'someone-else',
            lifetime: session.signal, holder })).rejects.toMatchObject({ code: 'managed_target_access_unavailable' });
        expect(h.calls).toEqual([]);
        // The custodian reaches the guest: the holder bootstrap starts with the shared platform probe (exec).
        await driver.openSessionTarget({ managedId: machine.id, sessionId: 's1', requesterAccountId: 'owner',
            lifetime: session.signal, holder }).catch(() => undefined);
        expect(h.calls[0]).toBe('exec');
    });

    it('refuses a row this controller does not currently hold', async () => {
        const h = harness();
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readPolicyCurrent: async () => null });
        await expect(driver.openSessionTarget({ managedId: machine.id, sessionId: 's1', requesterAccountId: 'owner',
            lifetime: new AbortController().signal, holder })).rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(h.calls).toEqual([]);
    });

    it('ends when custody is handed over: the next call is refused and a running channel is aborted', async () => {
        const h = harness({ holdStream: true, guest: true });
        let row = machine;
        let notify: (() => void) | undefined;
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readPolicyCurrent: async () => row,
            subscribeManagedMachineChanges: listener => { notify = () => void listener(); return () => { notify = undefined; }; } });
        const target = await driver.openSessionTarget({ managedId: machine.id, sessionId: 's1', requesterAccountId: 'owner',
            lifetime: new AbortController().signal, holder });
        const channel = target.openChannel(['holder', 'attach'], new AbortController().signal);
        const closed = new Promise(resolve => channel.once('close', resolve));
        channel.resume();
        await expect.poll(() => h.calls.includes('stream')).toBe(true);

        // Custody moves to another Account while the Session runs: the push revokes the open channel...
        row = { ...machine, custodianAccountId: 'next-owner' };
        notify!();
        await closed;
        // ...and every later call is refused before native IO.
        const before = h.calls.length;
        await expect(target.exec('true', new AbortController().signal)).rejects.toMatchObject({ code: 'managed_target_access_unavailable' });
        expect(h.calls.length).toBe(before);
    });

    it('sends target commands as the provider exec input, never in its argv (host and guest process lists)', async () => {
        const h = harness({ guest: true });
        const driver = createManagedMachineAcquisitionDriver({ ...h.input, readPolicyCurrent: async () => machine });
        const target = await driver.openSessionTarget({ managedId: machine.id, sessionId: 's1', requesterAccountId: 'owner',
            lifetime: new AbortController().signal, holder });
        await target.exec("printf '%s' fixture-agent-arg", new AbortController().signal);
        const last = h.inputs.at(-1) as { argv: string[]; inputBase64?: string };
        expect(JSON.stringify(last.argv)).not.toContain('fixture-agent-arg');
        expect(Buffer.from(last.inputBase64 ?? '', 'base64').toString()).toContain('fixture-agent-arg');
    });
});
