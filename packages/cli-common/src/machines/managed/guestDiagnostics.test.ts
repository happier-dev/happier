import { describe, expect, it } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedGuestDiagnosticsV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { readManagedGuestDiagnostics } from './guestDiagnostics.js';
import { ManagedMachineControllerError } from './controllerErrors.js';
import { SystemTaskExecutionError } from '../../systemTasks/runSystemTask.js';

const machine = ManagedMachineV1Schema.parse({
    id: 'retained', homeId: 'home', custodianAccountId: 'owner', enrolledMachineId: 'guest-machine',
    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
    resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'same-native' } },
    allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
});
const transport = { kind: 'native' as const, exec: 'exec', putFile: 'put-file' };
const snapshot = {
    daemonState: { pid: 7, httpPort: 8, startedAt: 9, startedWithCliVersion: 'test', hasControlToken: true,
        daemonLogPath: null, machineId: 'guest-machine' },
    daemonLogs: [], doctorSnapshot: null, stackContext: null,
    runtime: { cwd: '', platform: 'linux', nodeVersion: '' },
    sessionDiagnostics: { context: { sessionId: '', metadataStatus: 'unavailable' },
        logs: [{ kind: 'daemon', status: 'collected', artifact: {
            filename: 'daemon.log', sourceKind: 'daemon', contentType: 'text/plain', content: 'redacted daemon evidence',
        } }] },
};

describe('managed guest diagnostic disclosure', () => {
    it('names the missing enrollment before native collection and retains the inspect correlation', async () => {
        const result = await readManagedGuestDiagnostics({ machine: { ...machine, enrolledMachineId: undefined },
            requesterAccountId: 'owner', requestId: 'inspect-request', transport, channel: 'dev',
            native: { exec: async () => { throw new Error('Guest must not be contacted'); } } });
        expect(ManagedGuestDiagnosticsV1Schema.parse(result)).toEqual({ status: 'unavailable', code: 'guest_not_enrolled',
            phase: 'guest_identity', requestId: 'inspect-request' });
    });
    it('reads the fixed installed binary in the provider exec HOME without bootstrap, install or wake', async () => {
        const commands: string[] = [];
        const result = await readManagedGuestDiagnostics({ machine, requesterAccountId: 'owner', transport, channel: 'dev',
            native: { exec: async request => {
                expect(request.allowWake).toBe(false);
                commands.push(request.command);
                return { status: 0, stdout: JSON.stringify(snapshot), stderr: '' };
            } } });
        expect(result).toMatchObject({ status: 'collected', snapshot: { daemonState: { machineId: 'guest-machine' } } });
        expect(commands).toHaveLength(1);
        expect(commands[0]).toContain('"$HOME"/\'.happier/');
        expect(commands[0]).toContain("'doctor' '--json' '--include-daemon-log'");
        expect(commands[0]).not.toContain('start');
        expect(commands[0]).not.toContain('install');
    });
    it('does not execute before custody is established', async () => {
        const result = await readManagedGuestDiagnostics({ machine, requesterAccountId: 'creator',
            transport, channel: 'dev', native: { exec: async () => { throw new Error('Guest must not be contacted'); } } });
        expect(result).toEqual({ status: 'unavailable', code: 'permission_denied', phase: 'guest_custody' });
    });
    it.each(['another-machine', undefined])('withholds logs when the ambient daemon identity is %s', async machineId => {
        const result = await readManagedGuestDiagnostics({ machine, requesterAccountId: 'owner', transport, channel: 'dev',
            native: { exec: async () => ({ status: 0,
                stdout: JSON.stringify({ ...snapshot, daemonState: { ...snapshot.daemonState, machineId } }), stderr: '' }) } });
        expect(result).toEqual({ status: 'unavailable', code: machineId ? 'resource_mismatch' : 'guest_identity_unavailable', phase: 'guest_identity' });
        expect(JSON.stringify(result)).not.toContain('redacted daemon evidence');
    });
    it('reports native command failure without disclosing raw stdout or stderr', async () => {
        const result = await readManagedGuestDiagnostics({ machine, requesterAccountId: 'owner', transport, channel: 'dev',
            native: { exec: async () => ({ status: 127, stdout: 'private stdout', stderr: 'private credential' }) } });
        expect(result).toEqual({ status: 'unavailable', code: 'remote_command_failed', phase: 'guest_collection', exitCode: 127 });
    });
    it.each(['not-json', '{}'])('reports invalid collector output without disclosing it (%s)', async stdout => {
        const result = await readManagedGuestDiagnostics({ machine, requesterAccountId: 'owner', requestId: 'inspect-request',
            transport, channel: 'dev', native: { exec: async () => ({ status: 0, stdout, stderr: 'private credential' }) } });
        expect(ManagedGuestDiagnosticsV1Schema.parse(result)).toEqual({ status: 'unavailable', code: 'invalid_action_output',
            phase: 'guest_output', requestId: 'inspect-request' });
    });
    it.each([
        { error: new ManagedMachineControllerError('credential_unavailable'), code: 'credential_unavailable' },
        { error: new SystemTaskExecutionError('resource_mismatch', 'private native detail'), code: 'resource_mismatch' },
        { error: Object.assign(new Error('private native detail'), { code: 'admission_unavailable' }), code: 'admission_unavailable' },
        { error: new Error('private native detail'), code: 'action_failed' },
    ])('preserves typed native refusal without disclosing exceptions ($code)', async ({ error, code }) => {
        const result = await readManagedGuestDiagnostics({ machine, requesterAccountId: 'owner', transport, channel: 'dev',
            native: { exec: async () => { throw error; } } });
        expect(result).toEqual({ status: 'unavailable', code, phase: 'guest_collection' });
        expect(JSON.stringify(result)).not.toContain('private native detail');
    });
});
