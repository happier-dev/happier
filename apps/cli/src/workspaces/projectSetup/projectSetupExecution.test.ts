import axios from 'axios';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ActionOperationOwnerUpdate } from '@/daemon/actionOperations/actionOperationTypes';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { PtyProcess, PtyProvider, PtySpawnParams, PtyExitEvent } from '@/terminal/pty/provider';
import { createProjectSetupSuccessStore } from './projectSetupSuccess';
import { reviewProjectSetupEffect, type ProjectSetupPreparationInput } from './projectSetupPreparation';
import { executeProjectSetup, type ProjectSetupExecutionInput } from './projectSetupExecution';
import { createProjectNativeToolchainIoForHost } from '@/plugins/runtime/invocation/services/exec';

// Entry callers cannot supply consent carried by an already admitted executor.
expectTypeOf<ProjectSetupPreparationInput>().not.toHaveProperty('admittedConsent');
expectTypeOf<ProjectSetupExecutionInput['preparation']>().not.toHaveProperty('admittedConsent');

// The OS PTY and process-tree stop are system boundaries. Preparation, trust,
// completion storage and terminal custody stay real. The host publication sink
// records updates; composed Action-runner verification belongs to integration.
class ObservedPty implements PtyProcess {
    readonly pid = 12345;
    readonly ownedProcessGroupId = 12345;
    private readonly exits = new Set<(event: PtyExitEvent) => void>();
    write() { throw new Error('finite command must not use interactive input'); }
    resize() {}
    kill() {}
    onData() { return { dispose() {} }; }
    onExit(listener: (event: PtyExitEvent) => void) { this.exits.add(listener); return { dispose: () => this.exits.delete(listener) }; }
    exit(exitCode: number) { for (const listener of this.exits) listener({ exitCode, signal: 0 }); }
}

describe('finite Project setup execution', () => {
    const roots: string[] = [];
    const managers: Array<ReturnType<typeof createTerminalPtySessionManager>> = [];
    afterEach(async () => {
        managers.splice(0).forEach(manager => manager.dispose());
        vi.restoreAllMocks();
        await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
    });

    async function fixture(commands: string[], teardown: string[] = []) {
        const root = await mkdtemp(join(tmpdir(), 'happier-finite-setup-'));
        roots.push(root);
        await mkdir(join(root, '.happier'));
        const manifest = { version: 1, workspace: { setup: commands.map(command => ({ kind: 'command', command })), teardown: teardown.map(command => ({ kind: 'command', command })) } };
        await writeFile(join(root, '.happier/project.json'), JSON.stringify(manifest));
        const workspace = { id: 'workspace', serverId: 'home', machineId: 'machine', rootPath: root, projectKey: 'project', createdAtMs: 1 };
        const preparation: ProjectSetupPreparationInput = {
            workspace, projectAssociation: { workspace, project: { serverId: 'home', projectId: 'project' } },
            requester: { credentials: { token: 'requester', encryption: null }, serverHttpBaseUrl: 'https://requester.example' },
            purpose: 'setup', platform: { os: 'linux', arch: 'x64' }, successHomeDir: join(root, 'completed'),
            nativeIo: { resolveTool: async () => null },
        };
        const review = await reviewProjectSetupEffect(preparation);
        if (review.kind !== 'reviewed') throw new Error(review.code);
        let trustDigest: string | null = review.plan.reviewedEffectDigest;
        vi.spyOn(axios, 'get').mockImplementation(async (_url, options) => {
            expect(options?.headers?.Authorization).toBe('Bearer requester');
            return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        });
        vi.spyOn(axios, 'post').mockImplementation(async (_url, _body, options) => {
            expect(options?.headers?.Authorization).toBe('Bearer requester');
            return { status: 200, data: trustDigest === null ? { status: 'absent' } : { status: 'present', revision: 1, content: { t: 'plain', v: {
                project: preparation.projectAssociation.project, reviewedEffectDigest: trustDigest, approvedAtMs: 1,
            } } } };
        });
        const spawned: Array<{ launch: PtySpawnParams; pty: ObservedPty }> = [];
        const ptyProvider: PtyProvider = { spawn(launch) { const pty = new ObservedPty(); spawned.push({ launch, pty }); return pty; } };
        let stopped = 0;
        let stopUnconfirmed = false;
        const manager = createTerminalPtySessionManager({ ptyProvider, env: { SHELL: '/bin/bash' },
            probeProcessGroup: () => 'absent',
            stopProcessTree: async () => { stopped++; if (stopUnconfirmed) throw Object.assign(new Error('termination incomplete'), { code: 'plugin_exec_termination_incomplete' }); },
            config: { bufferMaxBytes: 100000, bufferMaxEvents: 1000,
                urlParseBufferLimit: 32768, maxWriteChunkBytes: 16384, defaultCols: 80, defaultRows: 24 },
        });
        managers.push(manager);
        const updates: ActionOperationOwnerUpdate[] = [];
        const store = createProjectSetupSuccessStore({ homeDir: preparation.successHomeDir! });
        const target = { serverId: 'home', machineId: 'machine', workspaceRefId: 'workspace' };
        const start = (overrides: Partial<typeof preparation> & { skipForInvocation?: boolean } = {},
            executionOverrides: Partial<ProjectSetupExecutionInput> = {}) => {
            const controller = new AbortController();
            const execution = (async () => {
                const outcome = await executeProjectSetup({ preparation: { ...preparation, ...overrides }, requesterAccountId: 'requester-account',
                    operation: { actionRequestId: 'operation', signal: controller.signal, operationProgress: { update() {} },
                        operationOwnerUpdate: { update: update => updates.push(update) } },
                    terminalSessions: manager, platform: 'linux', hostEnvironment: { SHELL: '/bin/bash', PUBLIC: 'value' },
                    environmentIo: createProjectNativeToolchainIoForHost({ resolveTool: async () => null }),
                    ...executionOverrides });
                return outcome;
            })();
            return { execution, completion: execution.then(outcome => outcome.result), cancel: () => controller.abort() };
        };
        return { root, preparation, plan: review.plan, spawned, updates, store, target, start, manager,
            stopped: () => stopped, unconfirmedStop: () => { stopUnconfirmed = true; }, trust: (digest: string | null) => { trustDigest = digest; } };
    }

    it('refuses trusted setup commands when the held Agent isolation authority is unavailable', async () => {
        const f = await fixture(['echo must-not-run']);
        const run = f.start({}, { agentIsolation: { read: () => ({ enabled: true,
            status: { kind: 'unavailable', code: 'provisioning_unavailable' }, workspaceRoots: [f.root] }) } });
        let settled = false;
        const result = run.completion.then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
        await expect.poll(() => f.spawned.length || settled).toBeTruthy();
        for (const child of f.spawned) child.pty.exit(0);
        expect(await result).toMatchObject({ value: { ok: false, errorCode: 'workspace_exec_isolation_unavailable' } });
        expect(f.spawned).toEqual([]);
    });

    it('keeps invocation skip distinct from completion without any executable work', async () => {
        const f = await fixture(['echo setup']);
        expect(await f.start({ skipForInvocation: true }).execution).toMatchObject({ kind: 'no_launch', result: {
            ok: true, result: { kind: 'skippedForInvocation', reviewedEffectDigest: f.plan.reviewedEffectDigest },
        } });
        expect(f.spawned).toEqual([]);
        expect(f.updates).toEqual([]);
        expect(await f.store.read(f.target)).toBeNull();
    });

    it('publishes the qualified attachment before launch and records completion only after every ordered zero exit', async () => {
        const f = await fixture(['echo first', 'echo second']);
        const sourceWorkspace = { serverId: 'source-home', machineId: 'source-machine', workspaceId: 'selected-source', rootPath: '/source' };
        const script = { name: 'checked', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } as const;
        const run = f.start({}, { sourceWorkspace, script });
        await expect.poll(() => f.spawned.length).toBe(1);
        expect(f.updates[0]).toMatchObject({ domainRef: { kind: 'projectCommand', sourceWorkspace, script } });
        expect(f.updates[0]?.state).toBeUndefined();
        expect(f.updates[0]?.domainRef).not.toHaveProperty('terminalId');
        expect(f.updates.at(-1)).toMatchObject({ state: 'running', domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: 'home', machineId: 'machine', workspaceRefId: 'workspace', cwd: f.root, terminalId: expect.any(String) } });
        expect(f.updates.at(-1)?.domainRef).not.toHaveProperty('exitCode');
        expect(f.spawned[0]!.launch).toMatchObject({ file: '/bin/bash', args: ['-c', 'echo first'] });
        expect(await f.store.read(f.target)).toBeNull();
        f.spawned[0]!.pty.exit(0);
        await expect.poll(() => f.spawned.length).toBe(2);
        expect(await f.store.read(f.target)).toBeNull();
        f.spawned[1]!.pty.exit(0);
        expect(await run.completion).toMatchObject({ ok: true, result: { kind: 'success', reviewedEffectDigest: f.plan.reviewedEffectDigest } });
        expect(await f.store.matches(f.target, f.plan.successBasis)).toBe(true);
        expect((await run.execution).kind).toBe('process_settled');
        expect(await f.start().completion).toMatchObject({ ok: true, result: { kind: 'success' } });
        expect(f.spawned.length).toBe(2);
        for (const update of f.updates.filter(update => update.domainRef)) {
            expect(update.domainRef).toMatchObject({ sourceWorkspace, script });
        }
        expect(f.updates.at(-1)).toMatchObject({ domainRef: { purpose: 'setup', sourceWorkspace, script, exitCode: 0 } });
    });

    it.each([1, 3])('reads remembered consent once at admission for %i commands', async commandCount => {
        const f = await fixture(Array.from({ length: commandCount }, (_, step) => `echo step-${step}`));
        const run = f.start();
        for (let step = 0; step < commandCount; step++) {
            await expect.poll(() => f.spawned.length).toBe(step + 1);
            f.spawned[step]!.pty.exit(0);
        }
        expect(await run.completion).toMatchObject({ ok: true });
        expect(await f.store.matches(f.target, f.plan.successBasis)).toBe(true);
        const grantReads = vi.mocked(axios.post).mock.calls.filter(([url]) => url.endsWith('/read'));
        expect(grantReads).toHaveLength(1);
    });

    it('finishes admitted commands after consent withdrawal and refuses the next invocation needing setup', async () => {
        const f = await fixture(['echo first', 'echo second']);
        const run = f.start();
        let settled = false;
        const completion = run.completion.finally(() => { settled = true; });
        await expect.poll(() => f.spawned.length).toBe(1);
        f.trust(null);
        f.spawned[0]!.pty.exit(0);
        await expect.poll(() => f.spawned.length === 2 || settled).toBe(true);
        f.spawned[1]?.pty.exit(0);
        expect(await completion).toMatchObject({ ok: true, result: { kind: 'success' } });
        expect(await f.store.matches(f.target, f.plan.successBasis)).toBe(true);
        // A completed target has no setup effects to authorize. Invalidate its
        // completion to exercise the next invocation that needs executable work.
        await f.store.invalidate(f.target);
        expect(await f.start().completion).toMatchObject({ ok: false, errorCode: 'project_setup_consent_required' });
        expect(f.spawned).toHaveLength(2);
    });

    it('invalidates prior completion before a failing explicit teardown and never launches its second step', async () => {
        const f = await fixture(['echo setup'], ['echo teardown', 'echo must-not-run']);
        await f.store.recordCompletion(f.target, { v: 1, workspaceRefId: 'workspace', completedAtMs: 1, ...f.plan.successBasis });
        const review = await reviewProjectSetupEffect({ ...f.preparation, purpose: 'teardown' });
        if (review.kind !== 'reviewed') throw new Error(review.code);
        f.trust(review.plan.reviewedEffectDigest);
        const run = f.start({ purpose: 'teardown' });
        await expect.poll(() => f.spawned.length).toBe(1);
        expect(await f.store.read(f.target)).toBeNull();
        f.spawned[0]!.pty.exit(7);
        expect(await run.completion).toMatchObject({ ok: false, errorCode: 'project_setup_step_failed', details: { exitCode: 7, step: 0 } });
        expect(f.updates.at(-1)).toMatchObject({ domainRef: { purpose: 'teardown', exitCode: 7 } });
        expect(f.updates.at(-1)?.domainRef).not.toHaveProperty('script');
        expect(f.spawned.length).toBe(1);
        expect(await f.store.read(f.target)).toBeNull();
    });

    it('invalidates completion on explicit teardown even when no teardown hooks are declared', async () => {
        const f = await fixture(['echo setup']);
        await f.store.recordCompletion(f.target, { v: 1, workspaceRefId: 'workspace', completedAtMs: 1, ...f.plan.successBasis });
        expect(await f.start({ purpose: 'teardown' }).execution).toMatchObject({ kind: 'no_launch', result: {
            ok: true, result: { kind: 'notRequired' },
        } });
        expect(await f.store.read(f.target)).toBeNull();
        expect(f.spawned).toEqual([]);
    });

    it('keeps cancellation pending until observed exit and preserves output attachment without success', async () => {
        const f = await fixture(['echo first', 'echo second']);
        const run = f.start();
        await expect.poll(() => f.spawned.length).toBe(1);
        run.cancel();
        await expect.poll(() => f.stopped()).toBe(1);
        expect(f.updates.at(-1)?.state).not.toBe('cancelled');
        expect(await f.store.read(f.target)).toBeNull();
        f.spawned[0]!.pty.exit(0);
        expect(await run.completion).toMatchObject({ ok: false, errorCode: 'cancelled' });
        expect(f.spawned.length).toBe(1);
        expect((await run.execution).kind).toBe('process_settled');
        expect(f.updates.at(-1)).toMatchObject({ domainRef: { terminalId: expect.any(String) } });
    });

    it('refuses changed inputs before the next command even with admitted consent', async () => {
        const f = await fixture(['echo first', 'echo second']);
        const run = f.start();
        await expect.poll(() => f.spawned.length).toBe(1);
        await writeFile(join(f.root, '.happier/project.json'), JSON.stringify({ version: 1, workspace: { setup: [{ kind: 'command', command: 'echo changed' }] } }));
        f.spawned[0]!.pty.exit(0);
        expect(await run.completion).toMatchObject({ ok: false, errorCode: 'project_setup_effect_changed' });
        expect(f.spawned).toHaveLength(1);
        expect(await f.store.read(f.target)).toBeNull();
    });

    it('succeeds without recording completion when inputs change after the final command and re-runs new bytes next time', async () => {
        const f = await fixture(['echo setup']);
        const run = f.start();
        await expect.poll(() => f.spawned.length).toBe(1);
        await writeFile(join(f.root, '.happier/project.json'), JSON.stringify({ version: 1, workspace: { setup: [{ kind: 'command', command: 'echo changed' }] } }));
        f.spawned[0]!.pty.exit(0);
        expect(await run.completion).toMatchObject({ ok: true, result: { kind: 'success', reviewedEffectDigest: f.plan.reviewedEffectDigest } });
        expect(await f.store.read(f.target)).toBeNull();
        const pending = await executeProjectSetup({ preparation: f.preparation, requesterAccountId: 'requester-account',
            operation: { signal: new AbortController().signal, operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } },
            terminalSessions: managers[0]!, environmentIo: createProjectNativeToolchainIoForHost({ resolveTool: async () => null }) });
        expect(pending).toMatchObject({ kind: 'no_launch', result: { ok: false, errorCode: 'project_setup_consent_required', details: { kind: 'pendingApproval' } } });
        expect(JSON.stringify(pending)).not.toContain('secretEnvironment');
        expect(f.spawned.length).toBe(1);
        expect(await executeProjectSetup({ preparation: { ...f.preparation, skipForInvocation: true }, requesterAccountId: 'requester-account',
            operation: { signal: new AbortController().signal, operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } },
            terminalSessions: managers[0]!, environmentIo: createProjectNativeToolchainIoForHost({ resolveTool: async () => null }) }))
            .toMatchObject({ kind: 'no_launch', result: { ok: true, result: { kind: 'skippedForInvocation' } } });
        expect(await f.store.read(f.target)).toBeNull();
        const review = await reviewProjectSetupEffect(f.preparation);
        if (review.kind !== 'reviewed') throw new Error(review.code);
        f.trust(review.plan.reviewedEffectDigest);
        const next = f.start();
        await expect.poll(() => f.spawned.length).toBe(2);
        expect(f.spawned[1]!.launch.args).toEqual(['-c', 'echo changed']);
        f.spawned[1]!.pty.exit(0);
        expect(await next.completion).toMatchObject({ ok: true });
        expect(await f.store.matches(f.target, review.plan.successBasis)).toBe(true);
    });

    it('reports lost exit observation as uncertain, preserving no completion and never replaying', async () => {
        const f = await fixture(['echo first', 'echo second']);
        const run = f.start();
        await expect.poll(() => f.spawned.length).toBe(1);
        f.manager.dispose();
        expect(await run.execution).toMatchObject({ kind: 'outcome_uncertain', result: { ok: false, errorCode: 'outcome_uncertain' } });
        expect(await f.store.read(f.target)).toBeNull();
        expect(f.spawned.length).toBe(1);
    });

    it('publishes unconfirmed tree stop without treating root exit as completed cancellation', async () => {
        const f = await fixture(['echo setup']);
        const run = f.start();
        await expect.poll(() => f.spawned.length).toBe(1);
        f.unconfirmedStop();
        run.cancel();
        await expect.poll(() => f.stopped()).toBe(1);
        await expect.poll(() => f.updates.at(-1)).toMatchObject({ observation: { kind: 'stop_unconfirmed' } });
        f.spawned[0]!.pty.exit(0);
        expect(await f.store.read(f.target)).toBeNull();
        f.manager.dispose();
        expect(await run.execution).toMatchObject({ kind: 'outcome_uncertain', result: { ok: false, errorCode: 'stop_unconfirmed' } });
    });

    it('consumes the real native resolver tuple without an interactive shell wrapper', async () => {
        const f = await fixture([]);
        await writeFile(join(f.root, 'Makefile'), 'setup:\n\tprintf native\n');
        await writeFile(join(f.root, '.happier/project.json'), JSON.stringify({ version: 1, workspace: { setup: [
            { kind: 'native', tool: 'make', file: 'Makefile', target: 'setup' },
        ] } }));
        const nativeIo = { resolveTool: async () => ({ executablePath: '/managed/make', version: '1' }) };
        const reviewed = await reviewProjectSetupEffect({ ...f.preparation, nativeIo });
        if (reviewed.kind !== 'reviewed') throw new Error(reviewed.code);
        f.trust(reviewed.plan.reviewedEffectDigest);
        const run = f.start({ nativeIo });
        await expect.poll(() => f.spawned.length).toBe(1);
        expect(f.spawned[0]?.launch).toMatchObject({ file: '/managed/make', args: ['-f', join(f.root, 'Makefile'), 'setup'] });
        f.spawned[0]!.pty.exit(0);
        expect(await run.execution).toMatchObject({ kind: 'process_settled', result: { ok: true } });
        expect(await f.store.matches(f.target, reviewed.plan.successBasis)).toBe(true);
    });

    it('refuses native environment evaluation under the held Agent isolation authority before the helper effect', async () => {
        const f = await fixture([]);
        await writeFile(join(f.root, 'mise.toml'), '[env]\nNATIVE_VALUE = "prepared"\n');
        await writeFile(join(f.root, '.happier/project.json'), JSON.stringify({ version: 1,
            toolchain: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' } }));
        const nativeIo = { resolveTool: async () => ({ executablePath: process.execPath, version: '2026.10.4' }) };
        const reviewed = await reviewProjectSetupEffect({ ...f.preparation, nativeIo });
        if (reviewed.kind !== 'reviewed') throw new Error(reviewed.code);
        f.trust(reviewed.plan.reviewedEffectDigest);
        const marker = join(f.root, 'must-not-evaluate');
        const agentIsolation = { read: () => ({ enabled: true,
            status: { kind: 'unavailable' as const, code: 'provisioning_unavailable' as const }, workspaceRoots: [f.root] }) };
        const environmentIo = createProjectNativeToolchainIoForHost(Object.assign({ resolveTool: async () => ({
            executablePath: process.execPath, version: '2026.10.4', args: ['-e',
                `require('node:fs').writeFileSync(${JSON.stringify(marker)},'evaluated');process.stdout.write('NATIVE_VALUE=prepared\\0');`, '--'],
        }) }, { agentIsolation }));
        expect(await f.start({ nativeIo }, { environmentIo, agentIsolation }).completion)
            .toMatchObject({ ok: false, errorCode: 'workspace_exec_isolation_unavailable' });
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await f.store.read(f.target)).toBeNull();
        expect(f.spawned).toEqual([]);
    });

    it('produces a selected environment even when there are no declared setup steps', async () => {
        const f = await fixture([]);
        await writeFile(join(f.root, 'mise.toml'), '[env]\nNATIVE_VALUE = "prepared"\n');
        await writeFile(join(f.root, '.happier/project.json'), JSON.stringify({ version: 1,
            toolchain: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' } }));
        const nativeIo = { resolveTool: async () => ({ executablePath: process.execPath, version: '2026.10.4' }) };
        const reviewed = await reviewProjectSetupEffect({ ...f.preparation, nativeIo });
        if (reviewed.kind !== 'reviewed') throw new Error(reviewed.code);
        f.trust(reviewed.plan.reviewedEffectDigest);
        const observedEnvironment = join(f.root, 'native-environment-path');
        const environmentIo = createProjectNativeToolchainIoForHost({ resolveTool: async () => ({
            executablePath: process.execPath, version: '2026.10.4', args: ['-e',
                `require('node:fs').writeFileSync(${JSON.stringify(observedEnvironment)},process.env.MISE_OVERRIDE_CONFIG_FILENAMES);process.stdout.write('NATIVE_VALUE=prepared\\0');`, '--'],
        }) });
        const run = f.start({ nativeIo }, { environmentIo });
        expect(await run.completion).toMatchObject({ ok: true, result: { kind: 'success' } });
        expect(await readFile(observedEnvironment, 'utf8')).toBe(join(f.root, 'mise.toml'));
        expect(await f.store.matches(f.target, reviewed.plan.successBasis)).toBe(true);
        expect(f.spawned).toEqual([]);
    });

    it('rechecks requester admission at the actual built-in person helper after awaited tool resolution', async () => {
        const f = await fixture([]);
        await writeFile(join(f.root, 'mise.toml'), '[env]\nNATIVE_VALUE = "prepared"\n');
        await writeFile(join(f.root, '.happier/project.json'), JSON.stringify({ version: 1,
            toolchain: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' } }));
        const nativeIo = { resolveTool: async () => ({ executablePath: process.execPath, version: '2026.10.4' }) };
        const reviewed = await reviewProjectSetupEffect({ ...f.preparation, nativeIo });
        if (reviewed.kind !== 'reviewed') throw new Error(reviewed.code);
        f.trust(reviewed.plan.reviewedEffectDigest);
        const marker = join(f.root, 'person-helper-ran');
        let requesterCurrent = true;
        let pauseResolution = false;
        let entered!: () => void;
        let resume!: () => void;
        const paused = new Promise<void>(resolve => { entered = resolve; });
        const resumed = new Promise<void>(resolve => { resume = resolve; });
        // Managed/system tool resolution is the external boundary; native
        // preparation, final launch authorization and process custody stay real.
        const environmentIo = createProjectNativeToolchainIoForHost({ async resolveTool() {
            if (pauseResolution) { entered(); await resumed; }
            return { executablePath: process.execPath, version: '2026.10.4', args: ['-e',
                `require('node:fs').writeFileSync(${JSON.stringify(marker)},'evaluated');process.stdout.write('NATIVE_VALUE=prepared\\0');`, '--'] };
        } });
        const execution: Partial<ProjectSetupExecutionInput> = { environmentIo, executionKind: 'person_break_glass',
            requesterIdentity: { kind: 'owner_person', requester: { serverId: 'home', accountId: 'owner',
                machineId: 'machine', installationId: 'installation' } },
            agentIsolation: { read: () => ({ enabled: true,
                status: { kind: 'unavailable', code: 'provisioning_unavailable' }, workspaceRoots: [f.root] }) },
            async beforeNativeEffect() {
                if (!requesterCurrent) throw Object.assign(new Error('Requester retired'), { code: 'requester_retired' });
            },
        };
        expect(await f.start({ nativeIo }, execution).completion).toMatchObject({ ok: true });
        expect(await readFile(marker, 'utf8')).toBe('evaluated');
        await rm(marker);
        await f.store.invalidate(f.target);
        pauseResolution = true;
        const waiting = f.start({ nativeIo }, execution).completion;
        expect(await Promise.race([paused.then(() => 'paused'), waiting.then(() => 'settled')])).toBe('paused');
        requesterCurrent = false;
        resume();
        expect(await waiting).toMatchObject({ ok: false });
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await f.store.read(f.target)).toBeNull();
        expect(f.spawned).toEqual([]);
    });

    it('does not record environment-only completion when reviewed configuration changes during native evaluation', async () => {
        const f = await fixture([]);
        const config = join(f.root, 'mise.toml');
        await writeFile(config, '[env]\nNATIVE_VALUE = "prepared"\n');
        await writeFile(join(f.root, '.happier/project.json'), JSON.stringify({ version: 1,
            toolchain: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' } }));
        const nativeIo = { resolveTool: async () => ({ executablePath: process.execPath, version: '2026.10.4' }) };
        const reviewed = await reviewProjectSetupEffect({ ...f.preparation, nativeIo });
        if (reviewed.kind !== 'reviewed') throw new Error(reviewed.code);
        f.trust(reviewed.plan.reviewedEffectDigest);
        const environmentIo = createProjectNativeToolchainIoForHost({ resolveTool: async () => ({
            executablePath: process.execPath, version: '2026.10.4', args: ['-e',
                `require('node:fs').writeFileSync(${JSON.stringify(config)},${JSON.stringify('[env]\nNATIVE_VALUE = "changed"\n')});process.stdout.write('NATIVE_VALUE=prepared\\0');`, '--'],
        }) });
        const run = f.start({ nativeIo }, { environmentIo });
        expect(await run.execution).toMatchObject({ kind: 'no_launch', result: {
            ok: false, errorCode: 'project_setup_effect_changed',
        } });
        expect(await f.store.read(f.target)).toBeNull();
        expect(f.spawned).toEqual([]);
    });

});
