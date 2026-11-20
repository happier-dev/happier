import type { JsonValue } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { executeManagedMachinePowerIntent } from './power.js';
import { SystemTaskExecutionError } from '../../systemTasks/runSystemTask.js';

const machine = ManagedMachineFullV1Schema.parse({
    id: 'retained', homeId: 'home', custodianAccountId: 'owner',
    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
    resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'same-native' } },
    allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
});

describe('shared admitted native power', () => {
    it.each(['start', 'resume'] as const)('observes vendor power before %s and never wakes already running compute', async desired => {
        const calls: string[] = [];
        const observation = { observedAt: 5, availability: 'present' as const, power: 'running' as const, storage: 'retained' as const };
        const value = await executeManagedMachinePowerIntent({ machine: { ...machine, desired,
            observation: { ...observation, observedAt: 1, power: 'stopped' } },
            invoke: async role => { calls.push(role); return role === 'inspect' ? observation : { kind: 'confirmed' }; } });
        expect(value).toEqual({ result: { kind: 'confirmed' }, observation });
        expect(calls).toEqual(['inspect']);
    });

    it('wakes a vendor-stopped Machine despite a stored running observation', async () => {
        const calls: string[] = [];
        let powerApplied = false;
        const value = await executeManagedMachinePowerIntent({ machine: { ...machine,
            observation: { observedAt: 1, availability: 'present', power: 'running', storage: 'retained' } },
            invoke: async (role): Promise<JsonValue> => {
                calls.push(role);
                if (role === 'power') { powerApplied = true; return { kind: 'confirmed' }; }
                return { observedAt: 5, availability: 'present', power: powerApplied ? 'running' : 'stopped', storage: 'retained' };
            } });
        expect(value.observation?.power).toBe('running');
        expect(calls).toEqual(['inspect', 'power', 'inspect']);
    });

    const unavailableInspectResponses: readonly JsonValue[] = [
        { observedAt: 5, availability: 'unavailable' as const, reason: 'transport' },
        { observedAt: 5, availability: 'absent' as const },
        { observedAt: 5, availability: 'present' as const, power: 'unknown' as const },
        { observedAt: 5, availability: 'present' as const, power: 'stopped' as const, storage: 'lost' as const },
    ];
    it.each(unavailableInspectResponses)('retains the native observation when Inspect refuses a wake ($availability)', async observation => {
        const calls: string[] = [];
        await expect(executeManagedMachinePowerIntent({ machine, invoke: async (role): Promise<JsonValue> => {
            calls.push(role);
            return role === 'inspect' ? observation : { kind: 'confirmed' };
        } })).resolves.toEqual({ result: { kind: 'refused', code: 'provider_unavailable' }, observation });
        expect(calls).toEqual(['inspect']);
    });

    it('re-observes an uncertain power effect after transport recovery without sending power again', async () => {
        const roles: string[] = [];
        let waits = 0;
        const value = await executeManagedMachinePowerIntent({ machine: { ...machine, desired: 'stop' },
            waitForObservation: async () => { waits++; },
            invoke: async (role): Promise<JsonValue> => {
                roles.push(role);
                if (role === 'power') return { kind: 'unknown', code: 'transport' };
                return waits ? { observedAt: 2, availability: 'present', power: 'stopped' }
                    : { observedAt: 1, availability: 'unavailable', reason: 'transport' };
            } });
        expect(value).toEqual({ result: { kind: 'unknown', code: 'transport' },
            observation: { observedAt: 2, availability: 'present', power: 'stopped' } });
        expect(roles).toEqual(['power', 'inspect', 'inspect']);
        expect(waits).toBe(1);
    });
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
        expect(calls.map(call => call.role)).toEqual(initialPower === 'running'
            ? ['inspect', 'bootstrap', 'exec'] : ['inspect', 'power', 'inspect', 'bootstrap', 'exec']);
        expect(calls.at(-1)?.body).toMatchObject({ resource: machine.resource!.value,
            processConfig: { environment: { HOME: '/persistent/home', HAPPIER_HOME_DIR: '/persistent/home/.happier' },
                detachedDaemonStartArgv: ['sh', '-c', expect.stringContaining("'daemon' 'start' '--json'")] } });
        expect(JSON.stringify(calls.at(-1)?.body)).toContain('start-sync');
        expect(JSON.stringify(calls.at(-1)?.body)).not.toContain('auth');
    });

    it.each(['native', 'systemTask'] as const)('keeps confirmed power and safe startup failure facts (%s)', async source => {
        const privateText = 'PRIVATE_NATIVE_STARTUP_OUTPUT';
        const native = Object.assign(new Error(privateText), { code: 'EACCES', status: 403 });
        const details = { kind: 'managedNative', nativeCause: { localCause: 'native_options_changed' } } as const;
        const failure = source === 'native' ? native
            : new SystemTaskExecutionError('provider_unavailable', privateText, { cause: native, details });
        const value = await executeManagedMachinePowerIntent({
            machine: { ...machine, enrolledMachineId: 'same-machine', enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } },
            guestStartup: { channel: 'dev', transport: { kind: 'native', exec: 'exec', putFile: 'put-file' } },
            invoke: async (role): Promise<JsonValue> => {
                if (role === 'power') return { kind: 'confirmed' };
                if (role === 'inspect') return { observedAt: 1, availability: 'present', power: 'running', storage: 'retained' };
                if (role === 'bootstrap') return { kind: 'native', transport: { contributionRef: machine.resource!.contributionRef, schemaVersion: 1 },
                    guestHome: { homeDir: '/root', happyHomeDir: '/root/.happier', daemonStartup: 'native-process' } };
                throw failure;
            },
        });
        expect(value.result).toEqual({ kind: 'confirmed' });
        expect(value.observation).toMatchObject({ power: 'running' });
        expect(value.guestStartupError).toMatchObject({ code: 'native_boot_unconfirmed' });
        const projected = value.guestStartupError?.toActionFailure('machines.managed.power.set');
        expect(projected).toMatchObject({ errorCode: 'native_boot_unconfirmed',
            failureCause: { phase: 'machines.managed.power.set', errorCode: source === 'native' ? 'EACCES' : 'provider_unavailable',
                httpStatus: 403 },
            ...(source === 'systemTask' ? { details } : {}) });
        expect(JSON.stringify(projected)).not.toContain(privateText);
    });

    it.each([
        { enrollmentIdentity: { kind: 'guestProcess' as const, role: 'sandbox' as const } },
        { preset: { id: 'team-preset', revision: 2, contentEncryptionMode: 'e2ee' as const } },
    ])('starts enrolled native guests without a provider-owned persistent home (%j)', async source => {
        let command: unknown;
        let running = false;
        await executeManagedMachinePowerIntent({
            machine: { ...machine, ...source, enrolledMachineId: 'same-machine' },
            guestStartup: { channel: 'dev', transport: { kind: 'native', exec: 'exec', putFile: 'put-file' } },
            invoke: async (role, body): Promise<JsonValue> => {
                if (role === 'power') {
                    running = true;
                    return { kind: 'confirmed' };
                }
                if (role === 'inspect') return { observedAt: 1, availability: 'present', power: running ? 'running' : 'stopped', storage: 'retained' };
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
        expect(roles).toEqual(fields.desired === 'stop' ? ['power', 'inspect'] : ['inspect']);
    });

    it('executes the selected role once and keeps native acknowledgement separate from observed power', async () => {
        const calls: Array<{ role: string; body: unknown }> = [];
        const observation = { observedAt: 1, availability: 'present' as const, power: 'stopped' as const };
        const value = await executeManagedMachinePowerIntent({ machine, invoke: async (role, body) => {
            calls.push({ role, body });
            return role === 'power' ? { kind: 'confirmed' } : observation;
        } });
        expect(calls).toEqual([{ role: 'inspect', body: { resource: { id: 'same-native' } } },
            { role: 'power', body: { resource: { id: 'same-native' }, intent: 'start' } },
            { role: 'inspect', body: { resource: { id: 'same-native' } } }]);
        expect(value).toEqual({ result: { kind: 'confirmed' }, observation });
    });
    it('does not inspect a definite Stop refusal and does not retry ambiguous delivery', async () => {
        const roles: string[] = [];
        expect(await executeManagedMachinePowerIntent({ machine: { ...machine, desired: 'stop' }, invoke: async role => {
            roles.push(role); return { kind: 'refused', code: 'provider_unavailable' };
        } })).toEqual({ result: { kind: 'refused', code: 'provider_unavailable' } });
        expect(roles).toEqual(['power']);
        roles.length = 0;
        await expect(executeManagedMachinePowerIntent({ machine: { ...machine, desired: 'stop' }, invoke: async role => {
            roles.push(role); throw new Error('connection lost after dispatch');
        } })).rejects.toThrow('connection lost after dispatch');
        expect(roles).toEqual(['power']);
    });
    it('preserves acknowledgement when observation is unavailable', async () => {
        expect(await executeManagedMachinePowerIntent({ machine: { ...machine, desired: 'stop' }, invoke: async role => {
            if (role === 'inspect') throw new Error('temporarily unavailable');
            return { kind: 'confirmed' };
        } })).toEqual({ result: { kind: 'confirmed' } });
    });
    it('keeps the admitted native observation owner advancing without another power call', async () => {
        const roles: string[] = [];
        let waits = 0;
        const value = await executeManagedMachinePowerIntent({ machine,
            waitForObservation: async () => { waits++; },
            invoke: async (role): Promise<JsonValue> => {
                roles.push(role);
                return role === 'power' ? { kind: 'confirmed' } : { observedAt: waits + 1, availability: 'present',
                    power: waits ? 'running' : 'stopped', storage: 'retained' };
            } });
        expect(value.observation?.power).toBe('running');
        expect(roles).toEqual(['inspect', 'power', 'inspect', 'inspect']);
        expect(waits).toBe(1);
    });
});
