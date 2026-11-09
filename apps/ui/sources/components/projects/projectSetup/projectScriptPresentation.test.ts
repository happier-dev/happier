import { describe, expect, it, vi } from 'vitest';
import { ActionOperationSnapshotV1Schema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
import { describeProjectCommandSource, findProjectInvocation, presentProjectRun } from './projectScriptPresentation';

function run(overrides: Partial<ActionOperationSnapshotV1> = {}): ActionOperationProjection {
    return { serverId: 'custody-home', observation: 'available', isUnavailableProjection: false, snapshot: {
        version: 1, operationId: 'script', revision: 1, actionId: 'projects.script.run', state: 'running',
        scope: { accountId: 'account', machineId: 'custody-machine' }, title: 'Build', createdAt: 1_000,
        startedAt: 2_000, cancellation: 'supported', domainRef: { kind: 'projectCommand', purpose: 'script',
            serverId: 'target-home', machineId: 'target-machine', workspaceRefId: 'target-workspace', cwd: '/target', terminalId: 'terminal' },
        ...overrides,
    } };
}

describe('finite Script row facts', () => {
    it('shows terminal failure instead of stale copying progress after an unknown worker cause', () => {
        const operation = run();
        const snapshot = ActionOperationSnapshotV1Schema.parse({ ...operation.snapshot, state: 'failed', settledAt: 4_000,
            progress: { kind: 'phase', phase: 'copying', label: 'Copying current files' },
            error: { errorCode: 'project_script_effect_changed', error: 'Project inputs changed', cause: { future: true } } });
        expect(presentProjectRun({ ...operation, snapshot }, 'Builder', 'idle'))
            .toMatchObject({ glyph: 'failed', live: false, tail: null });
    });

    it('projects queue position and preparation phase without inventing a launched process', () => {
        const command = { kind: 'projectCommand', purpose: 'script', serverId: 'target-home', machineId: 'target-machine', workspaceRefId: 'target-workspace', cwd: '/target' } as const;
        const queued = presentProjectRun(run({ state: 'accepted', domainRef: command, progress: { kind: 'phase', phase: 'queued', queueAhead: 2, label: 'Queued' } }), 'Builder', 'idle');
        expect(queued).toMatchObject({ phase: 'queued', queueAhead: 2, startedAt: null, glyph: 'queued' });
        for (const phase of ['preparing', 'copying', 'setup'] as const) {
            const preparing = presentProjectRun(run({ domainRef: command, progress: { kind: 'phase', phase, label: phase } }), 'Builder', 'idle');
            expect(preparing).toMatchObject({ phase, queueAhead: null, startedAt: null });
            // The stage is the status text; repeating it as a log tail would say it twice.
            expect(preparing.tail).toBeNull();
            expect(preparing.text).not.toContain('projects.scripts.run.running');
        }
        const uncertain = presentProjectRun(run({ state: 'accepted', domainRef: command, progress: { kind: 'phase', phase: 'queued', queueAhead: 0, label: 'Queued' }, observation: { kind: 'outcome_uncertain', code: 'transport_disconnected' } }), 'Builder', 'idle');
        expect(uncertain.text).toContain('projects.scripts.run.unknown');
    });

    it('says where a queued run waits and how many are ahead, and names the preparation step', () => {
        const command = { kind: 'projectCommand', purpose: 'script', serverId: 'target-home', machineId: 'target-machine', workspaceRefId: 'target-workspace', cwd: '/target' } as const;
        const queued = presentProjectRun(run({ state: 'accepted', domainRef: command, progress: { kind: 'phase', phase: 'queued', queueAhead: 2, label: 'Queued' } }), 'Builder', 'idle');
        expect(queued.text).toContain('projectWorkers.queuedOn');
        expect(queued.text).toContain('projectWorkers.ahead');
        const first = presentProjectRun(run({ state: 'accepted', domainRef: command, progress: { kind: 'phase', phase: 'queued', queueAhead: 0, label: 'Queued' } }), 'Builder', 'idle');
        expect(first.text).toContain('projectWorkers.queuedOn');
        expect(first.text).not.toContain('projectWorkers.ahead');
        expect(presentProjectRun(run({ domainRef: command, progress: { kind: 'phase', phase: 'copying', label: 'copying' } }), 'Builder', 'idle').text)
            .toContain('projectWorkers.copying');
        for (const phase of ['preparing', 'setup'] as const) {
            expect(presentProjectRun(run({ domainRef: command, progress: { kind: 'phase', phase, label: phase } }), 'Builder', 'idle').text)
                .toContain('projectWorkers.preparing');
        }
    });

    it('uses the canonical native invocation preview without guessing the package manager or changing source identity', () => {
        const source = { kind: 'native', tool: 'package_script', file: 'package.json', target: 'test' } as const;
        const invocation = { tool: 'yarn', args: ['test'], cwd: '/repo' };
        const described = describeProjectCommandSource(source, invocation);
        expect(described.command).toBe('yarn test');
        expect(described.target).toBe('test');
        expect(described.reference).toBe('package.json#test');
        expect(describeProjectCommandSource(source).command).toBeNull();
        expect(describeProjectCommandSource({ kind: 'command', command: 'python3 check.py' }).command).toBe('python3 check.py');
    });

    it('discloses executable paths and every argument boundary while retaining literal commands verbatim', () => {
        const source = { kind: 'native', tool: 'package_script', file: 'package.json', target: 'test' } as const;
        expect(describeProjectCommandSource(source, { tool: 'C:\\Program Files\\tool.exe', args: ['', 'a b', 'say "hello"', 'tail'] }).command)
            .toBe('"C:\\\\Program Files\\\\tool.exe" "" "a b" "say \\"hello\\"" tail');
        const command = '  echo "a b" && echo ""  ';
        expect(describeProjectCommandSource({ kind: 'command', command }).command).toBe(command);
    });

    it('names the actual execution placement, not the operation custody machine', () => {
        expect(presentProjectRun(run(), null, 'idle').text).toContain('machine=target-machine');
    });

    it('does not start a clock or invent duration from a required timestamp without actual launch evidence', () => {
        const noLaunch = run({ state: 'failed', settledAt: 44_000, error: { errorCode: 'project_command_policy_failed', error: 'Refused' },
            domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'target-home', machineId: 'target-machine', workspaceRefId: 'target-workspace', cwd: '/target' } });
        const presentation = presentProjectRun(noLaunch, null, 'idle');
        expect(presentation.startedAt).toBeNull();
        expect(presentation.text).not.toContain('duration');
        expect(presentProjectRun({ ...noLaunch, snapshot: { ...noLaunch.snapshot, state: 'running', settledAt: undefined, error: undefined } }, null, 'idle').startedAt).toBeNull();
    });

    it('leaves out a duration under a second instead of reading "0 s"', () => {
        const attachment = run().snapshot.domainRef;
        if (attachment?.kind !== 'projectCommand') throw new Error('Missing command fixture');
        const quick = (settledAt: number) => presentProjectRun(run({ state: 'failed', settledAt,
            error: { errorCode: 'project_command_step_failed', error: 'Build failed' },
            domainRef: { ...attachment, exitCode: 1 } }), null, 'idle');
        expect(quick(2_400).text).toContain('projects.scripts.run.exited(code=1');
        expect(quick(2_400).text).not.toContain('durationSeconds');
        expect(quick(3_000).text).toContain('durationSeconds(seconds=1)');
    });

    it('retains measured duration for failed and stopped launches and exposes observed step-failure exit only', () => {
        for (const state of ['failed', 'cancelled'] as const) {
            const operation = run({ state, settledAt: 44_000, error: state === 'failed' ? { errorCode: 'project_command_step_failed', error: 'Build failed' } : undefined });
            const attachment = operation.snapshot.domainRef;
            if (attachment?.kind !== 'projectCommand') throw new Error('Missing command fixture');
            const observed = { ...operation, snapshot: { ...operation.snapshot, domainRef: { ...attachment, exitCode: 7 } } };
            const presentation = presentProjectRun(observed, null, 'idle');
            expect(presentation.text).toContain('durationSeconds(seconds=42)');
            if (state === 'failed') expect(presentation.text).toContain('projects.scripts.run.exited(code=7');
            else expect(presentation.text).not.toContain('projects.scripts.run.exited');
        }
        const previousSetupExit = run({ state: 'failed', settledAt: 44_000, error: { errorCode: 'project_command_policy_failed', error: 'Refused after setup' },
            domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: 'target-home', machineId: 'target-machine', workspaceRefId: 'target-workspace', cwd: '/target', terminalId: 'setup-terminal', exitCode: 0 } });
        expect(presentProjectRun(previousSetupExit, null, 'idle').text).not.toContain('projects.scripts.run.exited');
    });
});

describe('runner previews for native references', () => {
    const ref = (target: string, file = 'package.json') => ({ kind: 'native', tool: 'package_script', file, target } as const);
    const preview = (args: string[]) => ({ tool: 'yarn', args, cwd: '/repo' });

    it('prefers a named command over an import offer and skips entries inspection gave no argv', () => {
        const inspection = {
            commands: [{ source: ref('test'), invocation: preview(['test', '--named']) }],
            importCandidates: [
                { source: ref('test'), invocation: preview(['test']) },
                { source: ref('lint') },
                { source: ref('lint'), invocation: preview(['lint']) },
            ],
        };
        expect(findProjectInvocation(inspection, ref('test'))?.args).toEqual(['test', '--named']);
        expect(findProjectInvocation(inspection, ref('lint'))?.args).toEqual(['lint']);
        expect(findProjectInvocation(inspection, ref('lint', 'other/package.json'))).toBeUndefined();
        expect(findProjectInvocation(inspection, { kind: 'command', command: 'make' })).toBeUndefined();
    });

    it('reads each previewed entry about once for a whole list of rows, not once per row (6,230 found scripts froze the Scripts page)', () => {
        const count = 2_000;
        let reads = 0;
        const counted = <T,>(entries: T[]): T[] => new Proxy(entries, {
            get(target, key, receiver) {
                if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
                return Reflect.get(target, key, receiver);
            },
        });
        const sources = Array.from({ length: count }, (_, index) => ref(`script-${index}`, `packages/p${index % 97}/package.json`));
        const inspection = {
            commands: counted([] as Array<{ source: ReturnType<typeof ref>; invocation?: ReturnType<typeof preview> }>),
            importCandidates: counted(sources.map(source => ({ source, invocation: preview([source.target]) }))),
        };
        // The page, its rows and every later render ask for each row's preview.
        for (let pass = 0; pass < 3; pass += 1)
            for (const source of sources) expect(findProjectInvocation(inspection, source)?.args).toEqual([source.target]);
        expect(reads).toBeLessThanOrEqual(2 * count);
        // A newer inspection is read afresh, never answered from the older one.
        const newer = { importCandidates: [{ source: sources[0]!, invocation: preview(['changed']) }] };
        expect(findProjectInvocation(newer, sources[0]!)?.args).toEqual(['changed']);
    });
});
