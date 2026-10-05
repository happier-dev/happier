import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runWithRealGitScmRuntime } from '../testkit/scmRuntime.test-support.js';
import { createGitTemporaryIndex } from './commitExecutionRuntime.js';

describe('commit temporary index seed', () => {
    it('uses the captured tree rather than a subsequently advanced HEAD', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'happier-index-seed-'));
        const git = (args: string[], env?: Record<string, string>) => execFileSync('git', args, {
            cwd, encoding: 'utf8', env: { ...process.env, ...env },
        }).trim();
        try {
            git(['init', '-q']);
            git(['config', 'user.email', 'test@example.com']);
            git(['config', 'user.name', 'Happier Test']);
            writeFileSync(join(cwd, 'file.txt'), 'captured\n');
            git(['add', '.']);
            git(['commit', '-qm', 'captured']);
            const treeOid = git(['rev-parse', 'HEAD^{tree}']);
            writeFileSync(join(cwd, 'file.txt'), 'later\n');
            git(['commit', '-qam', 'later']);
            const result = await runWithRealGitScmRuntime(() => createGitTemporaryIndex({
                cwd,
                seed: { kind: 'tree', treeOid },
            }));
            expect(result.success).toBe(true);
            if (!result.success) throw new Error(result.error);
            try {
                expect(git(['write-tree'], result.tempIndex.env)).toBe(treeOid);
            } finally {
                result.tempIndex.cleanup();
            }
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
