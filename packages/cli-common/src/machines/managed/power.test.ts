import type { JsonValue } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { executeManagedMachinePowerIntent } from './power.js';

const machine = ManagedMachineV1Schema.parse({
    id: 'retained', homeId: 'home', custodianAccountId: 'owner',
    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
    resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'same-native' } },
    allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
});

describe('shared admitted native power', () => {
    it.each([
        { desired: 'start' as const, initialPower: 'running' as const },
        { desired: 'resume' as const, initialPower: 'running' as const },
        { desired: 'start' as const, initialPower: 'stopped' as const },
        { desired: 'resume' as const, initialPower: 'stopped' as const },
    ])('restores the retained native daemon after $desired from $initialPower without reinstalling or pairing', async ({ desired, initialPower }) => {
        const calls: Array<{ role: string; body: unknown }> = [];
        let powerApplied = false;
        const value = await executeManagedMachinePowerIntent({
            machine: { ...machine, desired, enrolledMachineId: 'same-machine', enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } },
            guestStartup: { channel: 'dev', transport: { kind: 'native', exec: 'exec', putFile: 'put-file' } },
            invoke: async (role, body): Promise<JsonValue> => {
                calls.push({ role, body });
                if (role === 'power') { powerApplied = true; return { kind: 'confirmed' }; }
                if (role === 'inspect') return { observedAt: 1, availability: 'present', power: powerApplied ? 'running' : initialPower, storage: 'retained' };
                if (role === 'bootstrap') return { kind: 'native', transport: { contributionRef: machine.resource!.contributionRef, schemaVersion: 1 },
                    guestHome: { homeDir: '/persistent/home', happyHomeDir: '/persistent/home/.happier', daemonStartup: 'native-process' } };
                if (role === 'exec') return { kind: 'process-configured' };
                throw new Error(`Unexpected guest effect: ${role}`);
            },
        });
        expect(value.result.kind).toBe('confirmed');
        expect(calls.map(call => call.role)).toEqual(['power', 'inspect', 'bootstrap', 'exec']);
        expect(calls.at(-1)?.body).toMatchObject({ resource: machine.resource!.value,
            processConfig: { environment: { HOME: '/persistent/home', HAPPIER_HOME_DIR: '/persistent/home/.happier' },
                detachedDaemonStartArgv: ['sh', '-c', expect.stringContaining("'daemon' 'start' '--json'")] } });
        expect(JSON.stringify(calls.at(-1)?.body)).toContain('start-sync');
        expect(JSON.stringify(calls.at(-1)?.body)).not.toContain('auth');
    });

    it('keeps the confirmed power observation when the retained daemon cannot start', async () => {
        const value = await executeManagedMachinePowerIntent({
            machine: { ...machine, enrolledMachineId: 'same-machine', enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } },
            guestStartup: { channel: 'dev', transport: { kind: 'native', exec: 'exec', putFile: 'put-file' } },
            invoke: async (role): Promise<JsonValue> => {
                if (role === 'power') return { kind: 'confirmed' };
                if (role === 'inspect') return { observedAt: 1, availability: 'present', power: 'running', storage: 'retained' };
                if (role === 'bootstrap') return { kind: 'native', transport: { contributionRef: machine.resource!.contributionRef, schemaVersion: 1 },
                    guestHome: { homeDir: '/root', happyHomeDir: '/root/.happier', daemonStartup: 'native-process' } };
                throw new Error('Native startup transport unavailable');
            },
        });
        expect(value.result).toEqual({ kind: 'confirmed' });
        expect(value.observation).toMatchObject({ power: 'running' });
        expect(value.guestStartupError).toMatchObject({ code: 'native_boot_unconfirmed' });
    });

    it('starts guest-process carriers without a provider-owned persistent home through the same installed CLI', async () => {
        let command: unknown;
        await executeManagedMachinePowerIntent({
            machine: { ...machine, enrolledMachineId: 'same-machine', enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } },
            guestStartup: { channel: 'dev', transport: { kind: 'native', exec: 'exec', putFile: 'put-file' } },
            invoke: async (role, body): Promise<JsonValue> => {
                if (role === 'power') return { kind: 'confirmed' };
                if (role === 'inspect') return { observedAt: 1, availability: 'present', power: 'running', storage: 'retained' };
                if (role === 'bootstrap') return { kind: 'native', transport: { contributionRef: machine.resource!.contributionRef, schemaVersion: 1 } };
                command = body;
                return { stdoutBase64: '', stderrBase64: '', stdoutTruncated: false, stderrTruncated: false,
                    termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: 0 } } };
            },
        });
        expect(command).toMatchObject({ resource: machine.resource!.value, argv: ['sh', '-c', expect.stringContaining("'daemon' 'start' '--json'")] });
        expect(command).not.toHaveProperty('processConfig');
    });

    it.each([
        { desired: 'stop' as const, enrolledMachineId: 'same-machine', enrollmentIdentity: { kind: 'guestProcess' as const, role: 'sandbox' as const } },
        { desired: 'start' as const },
        { desired: 'start' as const, enrolledMachineId: 'same-machine', enrollmentIdentity: { kind: 'dedicatedDaemonUser' as const,
            username: 'happier' as const, serviceMode: 'user' as const, role: 'server' as const, adminAccessAtCreation: 'preauthorized' as const } },
    ])('leaves unenrolled, stopped and service-managed guests with their existing owner ($desired)', async fields => {
        const roles: string[] = [];
        await executeManagedMachinePowerIntent({ machine: { ...machine, ...fields },
            guestStartup: { channel: 'dev', transport: { kind: 'native', exec: 'exec', putFile: 'put-file' } },
            invoke: async (role): Promise<JsonValue> => {
                roles.push(role);
                return role === 'power' ? { kind: 'confirmed' } : { observedAt: 1, availability: 'present', power: 'running', storage: 'retained' };
            },
        });
        expect(roles).toEqual(['power', 'inspect']);
    });

    it('executes the selected role once and keeps native acknowledgement separate from observed power', async () => {
        const calls: Array<{ role: string; body: unknown }> = [];
        const observation = { observedAt: 1, availability: 'present' as const, power: 'stopped' as const };
        const value = await executeManagedMachinePowerIntent({ machine, invoke: async (role, body) => {
            calls.push({ role, body });
            return role === 'power' ? { kind: 'confirmed' } : observation;
        } });
        expect(calls).toEqual([{ role: 'power', body: { resource: { id: 'same-native' }, intent: 'start' } },
            { role: 'inspect', body: { resource: { id: 'same-native' } } }]);
        expect(value).toEqual({ result: { kind: 'confirmed' }, observation });
    });
    it('does not inspect a definite refusal and does not retry ambiguous delivery', async () => {
        const roles: string[] = [];
        expect(await executeManagedMachinePowerIntent({ machine, invoke: async role => {
            roles.push(role); return { kind: 'refused', code: 'provider_unavailable' };
        } })).toEqual({ result: { kind: 'refused', code: 'provider_unavailable' } });
        expect(roles).toEqual(['power']);
        roles.length = 0;
        await expect(executeManagedMachinePowerIntent({ machine, invoke: async role => {
            roles.push(role); throw new Error('connection lost after dispatch');
        } })).rejects.toThrow('connection lost after dispatch');
        expect(roles).toEqual(['power']);
    });
    it('preserves acknowledgement when observation is unavailable', async () => {
        expect(await executeManagedMachinePowerIntent({ machine, invoke: async role => {
            if (role === 'inspect') throw new Error('temporarily unavailable');
            return { kind: 'confirmed' };
        } })).toEqual({ result: { kind: 'confirmed' } });
    });
    it('keeps the admitted native observation owner advancing without another power call', async () => {
        const roles: string[] = [];
        const published: string[] = [];
        let waits = 0;
        const value = await executeManagedMachinePowerIntent({ machine,
            waitForObservation: async () => { waits++; },
            onObservation: async observation => { published.push(observation.power ?? 'unknown'); },
            invoke: async (role): Promise<JsonValue> => {
                roles.push(role);
                return role === 'power' ? { kind: 'confirmed' } : { observedAt: waits + 1, availability: 'present',
                    power: waits ? 'running' : 'stopped', storage: 'retained' };
            } });
        expect(value.observation?.power).toBe('running');
        expect(roles).toEqual(['power', 'inspect', 'inspect']);
        expect(published).toEqual(['stopped']);
        expect(waits).toBe(1);
    });
});
