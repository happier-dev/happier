import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan, type MachineRecipeStepV1 } from './index.js';
import { createMachineSetupNativeBackend, type MachineSetupNativeCommandResult } from './nativeBackend.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const basis = { kind: 'bootstrap' as const, managedId: 'm', operationId: 'op', admittedInputDigest: 'a'.repeat(64) };
const ok = (stdout = ''): MachineSetupNativeCommandResult => ({ code: 0, stdout, stderr: '' });
async function fixture(present = true, appearsBeforeCreate = false) {
    const root = await mkdtemp(join(tmpdir(), 'happier-admin-establish-')); roots.push(root);
    let uid = 1100;
    let outcome: 'success' | 'failure' | 'cancel' | 'cancelAfterSuccess' = 'success';
    let established = present;
    let verifier = present ? 'existing-verifier' : undefined;
    let accountReads = 0;
    let freshAccount: 'root' | 'missing' | undefined;
    const effects: string[] = [];
    const inputFrames: Uint8Array[] = [];
    const controller = new AbortController();
    const backend = createMachineSetupNativeBackend({ signal: controller.signal, run: async command => {
        if (command.executable === 'getent') {
            const name = command.args.at(-1)!;
            if (name === 'alice') {
                accountReads++;
                if (accountReads === 3 && appearsBeforeCreate) { present = true; established = true; verifier = 'existing-verifier'; }
                if (accountReads === 5 && freshAccount) return freshAccount === 'root' ? ok('alice:x:0:0::/root:/bin/sh\n') : { code: 2, stdout: '', stderr: '' };
                return present ? ok(`alice:x:${uid}:1100::/home/alice:/bin/sh\n`) : { code: 2, stdout: '', stderr: '' };
            }
            return ok(command.args.includes('passwd') ? `${name}:x:${process.getuid?.()}:${process.getgid?.()}::/tmp:/bin/sh\n` : `${name}:x:${process.getgid?.()}:\n`);
        }
        if (command.executable === 'useradd') { effects.push('useradd'); present = true; return ok(); }
        if (command.executable === 'passwd') return ok(`alice ${established ? 'P' : 'L'} 2026-01-01 0 99999 7 -1\n`);
        if (command.executable === 'fixture-native') {
            if (command.args[0] === 'check') return { code: 1, stdout: '', stderr: '' };
            effects.push('earlier-command'); return ok();
        }
        if (command.executable === '/usr/sbin/chpasswd') {
            effects.push('chpasswd');
            expect(command.args).toEqual([]);
            expect(JSON.stringify(command.env)).not.toContain('private:password');
            expect(Buffer.from(command.inputBytes!)).toEqual(Buffer.from('alice:private:password\n'));
            inputFrames.push(command.inputBytes!);
            if (outcome === 'cancel') { controller.abort(); throw new Error('private:password'); }
            established = outcome === 'success' || outcome === 'cancelAfterSuccess';
            if (established) verifier = 'setup-created-verifier';
            if (outcome === 'cancelAfterSuccess') controller.abort();
            return outcome === 'failure' ? { code: 1, stdout: 'private:password', stderr: 'private:password' } : ok();
        }
        if (command.executable === 'visudo') { effects.push('sudoers'); return ok(); }
        throw new Error(`Unexpected native boundary ${command.executable}`);
    } });
    const user: MachineRecipeStepV1 = { id: 'administrator', kind: 'user', username: 'alice' };
    const grant: MachineRecipeStepV1 = { id: 'grant', kind: 'file', path: join(root, 'sudoers'), owner: userInfo().username,
        group: userInfo().username, mode: 0o440, content: { kind: 'literal', value: '# Happier managed\npolicy\n' }, validate: 'sudoers' };
    return { backend, effects, inputFrames, controller, user, grant, readVerifier: () => verifier, setLocked() { established = false; }, setUid(value: number) { uid = value; },
        setFreshAccount(value: typeof freshAccount) { freshAccount = value; }, setOutcome(value: typeof outcome) { outcome = value; } };
}

describe('one-use bootstrap administrator establishment', () => {
    it.each([false, true])('sets a password only for a setup-created administrator and preserves an existing login (%s)', async present => {
        const f = await fixture(present);
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [f.user, f.grant], backend: f.backend });
        const password = Buffer.from('private:password');
        const events: unknown[] = [];
        const result = await applyMachineSetupEffectPlan({ plan, backend: f.backend,
            administratorEstablishment: { stepId: f.user.id, username: 'alice', password }, onProgress: event => events.push(event) });
        expect(result.status).toBe('applied');
        expect(f.effects).toEqual([...(present ? [] : ['useradd', 'chpasswd']), 'sudoers']);
        expect(f.readVerifier()).toBe(present ? 'existing-verifier' : 'setup-created-verifier');
        expect(await readFile(f.grant.kind === 'file' ? f.grant.path : '', 'utf8')).toContain('policy');
        expect(password.every(byte => byte === 0)).toBe(true);
        expect(f.inputFrames.every(frame => frame.every(byte => byte === 0))).toBe(true);
        expect(JSON.stringify({ result, events, plan })).not.toContain('private:password');
    });

    it('preserves the password when the native creation owner finds an account that appeared after CHECK', async () => {
        const f = await fixture(false, true);
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [f.user, f.grant], backend: f.backend });
        const password = Buffer.from('private:password');
        const result = await applyMachineSetupEffectPlan({ plan, backend: f.backend,
            administratorEstablishment: { stepId: f.user.id, username: 'alice', password } });
        expect(result.status).toBe('applied');
        expect(f.effects).toEqual(['sudoers']);
        expect(f.readVerifier()).toBe('existing-verifier');
        expect(password.every(byte => byte === 0)).toBe(true);
    });

    it.each([false, true])('establishes locked:false without an unsafe empty-verifier unlock (present %s)', async present => {
        const f = await fixture(present);
        const user = { ...f.user, locked: false };
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [user, f.grant], backend: f.backend });
        const password = Buffer.from('private:password');
        const result = await applyMachineSetupEffectPlan({ plan, backend: f.backend,
            administratorEstablishment: { stepId: user.id, username: 'alice', password } });
        expect(result.status).toBe('applied');
        expect(f.effects).toEqual([...(present ? [] : ['useradd', 'chpasswd']), 'sudoers']);
    });

    it.each([false, true])('preserves an existing locked administrator instead of setting or unlocking its password (requires unlocked %s)', async requiresUnlocked => {
        const f = await fixture(); f.setLocked();
        const user = requiresUnlocked ? { ...f.user, locked: false } : f.user;
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [user, f.grant], backend: f.backend });
        const password = Buffer.from('private:password');
        const result = await applyMachineSetupEffectPlan({ plan, backend: f.backend,
            administratorEstablishment: { stepId: user.id, username: 'alice', password } });
        expect(result.status).toBe(requiresUnlocked ? 'failed' : 'applied');
        expect(f.effects).toEqual(requiresUnlocked ? [] : ['sudoers']);
        expect(f.readVerifier()).toBe('existing-verifier');
        expect(password.every(byte => byte === 0)).toBe(true);
    });

    it.each(['uid0', 'locked', 'root', 'happier', 'wrongStep', 'wrongName', 'sudoersFirst', 'online', 'newline', 'nul', 'empty', 'stale', 'cancelled'] as const)('refuses %s with no effects and clears the supplied input', async mode => {
        const f = await fixture();
        if (mode === 'uid0') f.setUid(0);
        const user = mode === 'locked' ? { ...f.user, locked: true } : f.user;
        const earlier: MachineRecipeStepV1 = { id: 'earlier', kind: 'command', executable: 'fixture-native', args: ['apply'],
            check: { executable: 'fixture-native', args: ['check'], unsatisfiedExitCodes: [1] } };
        const steps = mode === 'sudoersFirst' ? [f.grant, user] : mode === 'uid0' ? [earlier, user, f.grant] : [user, f.grant];
        const plan = await checkMachineSetupEffectPlan({ basis: mode === 'online' ? { kind: 'setup', machineId: 'm', desiredRevision: 1 } : basis, steps, backend: f.backend });
        const password = Buffer.from(mode === 'newline' ? 'bad\ninput' : mode === 'nul' ? 'bad\0input' : mode === 'empty' ? '' : 'private:password');
        if (mode === 'cancelled') f.controller.abort();
        const result = await applyMachineSetupEffectPlan({ plan: mode === 'stale' ? { ...plan, planDigest: 'b'.repeat(64) } : plan,
            backend: f.backend, signal: f.controller.signal, administratorEstablishment: {
                stepId: mode === 'wrongStep' ? 'grant' : f.user.id,
                username: mode === 'root' ? 'root' : mode === 'happier' ? 'happier' : mode === 'wrongName' ? 'bob' : 'alice', password,
            } });
        expect(result.status).not.toBe('applied');
        expect(f.effects).toEqual([]);
        expect(password.every(byte => byte === 0)).toBe(true);
    });

    it.each(['failure', 'cancel'] as const)('keeps native %s after dispatch unknown and never activates sudoers or leaks diagnostics', async outcome => {
        const f = await fixture(false); f.setOutcome(outcome);
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [f.user, f.grant], backend: f.backend });
        const password = Buffer.from('private:password');
        const result = await applyMachineSetupEffectPlan({ plan, backend: f.backend,
            signal: f.controller.signal, administratorEstablishment: { stepId: f.user.id, username: 'alice', password } });
        expect(result).toMatchObject({ status: 'outcome_unknown', completedStepIds: ['administrator'], stepId: 'administrator' });
        expect(f.effects).toEqual(['useradd', 'chpasswd']);
        expect(JSON.stringify(result)).not.toContain('private:password');
        expect(password.every(byte => byte === 0)).toBe(true);
        expect(f.inputFrames[0]?.every(byte => byte === 0)).toBe(true);
    });

    it.each(['root', 'missing'] as const)('freshly refuses a %s local account immediately before native stdin delivery', async state => {
        const f = await fixture(false); f.setFreshAccount(state);
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [f.user, f.grant], backend: f.backend });
        const password = Buffer.from('private:password');
        const result = await applyMachineSetupEffectPlan({ plan, backend: f.backend,
            administratorEstablishment: { stepId: f.user.id, username: 'alice', password } });
        expect(result).toMatchObject({ status: 'failed', reason: 'validation_failed' });
        expect(f.effects).toEqual(['useradd']);
        expect(password.every(byte => byte === 0)).toBe(true);
    });

    it('keeps cancellation during final verification typed after a successful native verifier', async () => {
        const f = await fixture(false); f.setOutcome('cancelAfterSuccess');
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [f.user, f.grant], backend: f.backend });
        const password = Buffer.from('private:password');
        const result = await applyMachineSetupEffectPlan({ plan, backend: f.backend,
            signal: f.controller.signal, administratorEstablishment: { stepId: f.user.id, username: 'alice', password } });
        expect(result).toMatchObject({ status: 'outcome_unknown', completedStepIds: ['administrator'], reason: 'cancelled' });
        expect(f.effects).toEqual(['useradd', 'chpasswd']);
        expect(password.every(byte => byte === 0)).toBe(true);
    });
});
