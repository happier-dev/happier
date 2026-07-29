import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { resolveConnectedServiceMaterializedRootDir } from '../materialize/resolveConnectedServiceMaterializedRootDir';
import { createAdoptedExecutionRunRootCleanup } from './createAdoptedExecutionRunRootCleanup';

describe('createAdoptedExecutionRunRootCleanup', () => {
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
