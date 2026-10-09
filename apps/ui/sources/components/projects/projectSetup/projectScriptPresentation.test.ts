import { describe, expect, it, vi } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
import { describeProjectCommandSource, presentProjectRun } from './projectScriptPresentation';

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
    it('projects queue position and preparation phase without inventing a launched process', () => {
        const command = { kind: 'projectCommand', purpose: 'script', serverId: 'target-home', machineId: 'target-machine', workspaceRefId: 'target-workspace', cwd: '/target' } as const;
        const queued = presentProjectRun(run({ state: 'accepted', domainRef: command, progress: { kind: 'phase', phase: 'queued', queueAhead: 2, label: 'Queued' } }), 'Builder', 'idle');
        expect(queued).toMatchObject({ phase: 'queued', queueAhead: 2, startedAt: null, glyph: 'queued' });
        for (const phase of ['preparing', 'copying', 'setup'] as const) {
            const preparing = presentProjectRun(run({ domainRef: command, progress: { kind: 'phase', phase, label: phase } }), 'Builder', 'idle');
            expect(preparing).toMatchObject({ phase, queueAhead: null, startedAt: null });
            expect(preparing.text).not.toContain('projects.scripts.run.running');
        }
        const uncertain = presentProjectRun(run({ state: 'accepted', domainRef: command, progress: { kind: 'phase', phase: 'queued', queueAhead: 0, label: 'Queued' }, observation: { kind: 'outcome_uncertain' } }), 'Builder', 'idle');
        expect(uncertain.text).toContain('projects.scripts.run.unknown');
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
