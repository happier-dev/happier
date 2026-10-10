import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { resolveConnectedServiceMaterializedRootDir } from '../materialize/resolveConnectedServiceMaterializedRootDir';
import { createAdoptedExecutionRunRootCleanup } from './createAdoptedExecutionRunRootCleanup';
import { reloadConfiguration } from '@/configuration';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';

describe('createAdoptedExecutionRunRootCleanup', () => {
    it('preserves a recovered native home until its Run becomes unavailable', async () => {
        const sandbox = await mkdtemp(join(tmpdir(), 'happier-adopted-home-retention-'));
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
        try {
            envScope.patch({ HAPPIER_HOME_DIR: join(sandbox, 'cli') });
            reloadConfiguration();
            const state: ExecutionRunState = {
                runId: 'run-retained', callId: 'call', sidechainId: 'side', sessionId: null, depth: 0,
                intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
                instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable',
                runClass: 'bounded', ioMode: 'request_response', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
                resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: 'codex' }, providerSessionId: 'thread' },
            };
            await retainExecutionRunState(state);
            const base = join(sandbox, 'managed');
            const home = resolveConnectedServiceMaterializedRootDir({ baseDir: base, agentId: 'codex', materializationKey: state.runId });
            await mkdir(home, { recursive: true });
            const removeRoot = vi.fn(async () => undefined);
            const cleanup = createAdoptedExecutionRunRootCleanup({ materializationBaseDir: base,
                materializedRoot: home, agentId: 'codex', materializationKey: state.runId, removeRoot });
            await cleanup?.();
            expect(removeRoot).not.toHaveBeenCalled();
            await retainExecutionRunState({ ...state, resumeHandle: null });
            await mkdir(join(home, 'sessions'));
            await writeFile(join(home, 'sessions', 'rollout.jsonl'), '{}');
            await cleanup?.();
            expect(removeRoot).not.toHaveBeenCalled();
            await rm(join(home, 'sessions'), { recursive: true });
            await cleanup?.();
            expect(removeRoot).toHaveBeenCalledWith(home);
        } finally {
            envScope.restore(); reloadConfiguration(); await rm(sandbox, { recursive: true, force: true });
        }
    });

    it('accepts only the exact canonical run-key and agent root', () => {
        const expected = resolveConnectedServiceMaterializedRootDir({
            baseDir: '/managed/materialized',
            agentId: 'codex',
            materializationKey: 'run_abc',
        });
        const removeRoot = vi.fn(async () => undefined);
        expect(createAdoptedExecutionRunRootCleanup({
            materializationBaseDir: '/managed/materialized',
            materializedRoot: expected,
            agentId: 'codex',
            materializationKey: 'run_abc',
            removeRoot,
        })).not.toBeNull();
        expect(createAdoptedExecutionRunRootCleanup({
            materializationBaseDir: '/managed/materialized',
            materializedRoot: '/managed/materialized/another-run/codex',
            agentId: 'codex',
            materializationKey: 'run_abc',
            removeRoot,
        })).toBeNull();
        expect(createAdoptedExecutionRunRootCleanup({
            materializationBaseDir: '/managed/materialized',
            materializedRoot: '/managed/materialized-sibling/run/codex',
            agentId: 'codex',
            materializationKey: 'run_abc',
            removeRoot,
        })).toBeNull();
    });

    it('does not follow a symlinked canonical parent outside the base', async () => {
        const sandbox = await mkdtemp(join(tmpdir(), 'happier-dev-run-root-'));
        try {
            const base = join(sandbox, 'managed');
            const outside = join(sandbox, 'outside');
            const expected = resolveConnectedServiceMaterializedRootDir({
                baseDir: base,
                agentId: 'codex',
                materializationKey: 'run_abc',
            });
            await mkdir(base, { recursive: true });
            await mkdir(join(outside, 'codex'), { recursive: true });
            await symlink(outside, dirname(expected), 'dir');
            const removeRoot = vi.fn(async () => undefined);
            const cleanup = createAdoptedExecutionRunRootCleanup({
                materializationBaseDir: base,
                materializedRoot: expected,
                agentId: 'codex',
                materializationKey: 'run_abc',
                removeRoot,
            });

            await cleanup?.();

            expect(removeRoot).not.toHaveBeenCalled();
        } finally {
            await rm(sandbox, { recursive: true, force: true });
        }
    });
});
