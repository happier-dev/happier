import { describe, expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';

import { createStablePluginExecService } from './exec';

const boundary = vi.hoisted(() => ({ resolutions: 0, spawns: 0, releases: 0 }));
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
        if (args[0] !== 'fixture-spawn-admission') return actual.spawn(...args);
        boundary.spawns += 1;
        // Substitute only executable lookup at the OS boundary; the child is real.
        return actual.spawn(process.execPath, ...args.slice(1) as [readonly string[], import('node:child_process').SpawnOptions]);
    } };
});

function fixture() {
    Object.assign(boundary, { resolutions: 0, spawns: 0, releases: 0 });
    const controller = new AbortController();
    const exec = createStablePluginExecService({
        signal: controller.signal, isOccurrenceCurrent: () => true,
        resolveExecutable: async () => {
            boundary.resolutions += 1;
            return { command: 'fixture-spawn-admission', release() { boundary.releases += 1; } };
        },
        resolvePath: async () => process.cwd(),
    });
    const launch = { executable: { kind: 'systemTool', id: 'fixture.admission' }, args: ['-e', ''] } as const;
    return { exec, controller, launch };
}

describe('Exec spawn admission', () => {
    it.each(['run', 'spawn', 'jsonRpc'] as const)('admits %s once after preparation and before the OS effect', async entry => {
        const { exec, launch } = fixture();
        let admissions = 0;
        await exec.withSpawnAdmission(async () => {
            expect(boundary.resolutions).toBe(1);
            expect(boundary.spawns).toBe(0);
            admissions += 1;
        }, async scoped => {
            if (entry === 'run') {
                expect((await scoped.run(launch)).termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
                return;
            }
            const handle = entry === 'spawn' ? await scoped.spawn(launch)
                : await scoped.clients.spawn({ kind: 'jsonRpc', framing: 'jsonLines', launch });
            try { expect((await handle.wait()).termination.observed).toEqual({ kind: 'exit', exitCode: 0 }); }
            finally { await handle.dispose(); }
        });
        expect(admissions).toBe(1);
        expect(boundary.spawns).toBe(1);
        await vi.waitFor(() => expect(boundary.releases).toBe(1));
    });

    it('releases a prepared launch when admission refuses without spawning', async () => {
        const { exec, launch } = fixture();
        await expect(exec.withSpawnAdmission(async () => {
            throw new PluginError({ code: 'fixture_admission_refused', message: 'Admission refused' });
        }, scoped => scoped.run(launch))).rejects.toMatchObject({ code: 'fixture_admission_refused', execLaunch: 'notStarted' });
        expect(boundary.resolutions).toBe(1);
        expect(boundary.releases).toBe(1);
        expect(boundary.spawns).toBe(0);
    });

    it.each(['host', 'caller'] as const)('delivers %s cancellation to held admission and never spawns after it resumes', async cancelledBy => {
        const { exec, controller, launch } = fixture();
        const caller = new AbortController();
        let admissionSignal: AbortSignal | undefined;
        let entered!: () => void;
        let resume!: () => void;
        const admitted = new Promise<void>(resolve => { entered = resolve; });
        const hold = new Promise<void>(resolve => { resume = resolve; });
        const pending = exec.withSpawnAdmission(async (signal: AbortSignal) => { admissionSignal = signal; entered(); await hold; },
            scoped => scoped.clients.spawn({ kind: 'jsonRpc', framing: 'jsonLines', launch }, { signal: caller.signal }));
        const refusal = expect(pending).rejects.toMatchObject({ code: 'plugin_exec_aborted', execLaunch: 'notStarted' });
        try {
            await admitted;
            (cancelledBy === 'host' ? controller : caller).abort();
            await refusal;
            expect(admissionSignal?.aborted).toBe(true);
            expect(boundary.spawns).toBe(0);
        } finally { controller.abort(); caller.abort(); resume(); await pending.catch(() => undefined); }
        await vi.waitFor(() => expect(boundary.releases).toBe(1));
        expect(boundary.spawns).toBe(0);
    });
});
