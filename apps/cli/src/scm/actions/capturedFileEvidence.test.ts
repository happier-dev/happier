import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import { ScmComparisonCaptureOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { ScmDiffFileRequestSchema, ScmDiffFileResponseSchema } from '@happier-dev/protocol/scm';
import { WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES } from '@happier-dev/protocol/machines/workspaceFiles';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { configuration } from '@/configuration';
import { encodeRepositoryCheckpointScope } from '../checkpoints/refs';
import { deleteCapturedScmComparison, readCapturedScmComparison } from '../comparisons/captureScmComparison';
import { executeScmActionOperation } from './executeScmActionOperation';

describe('captured file Action evidence', () => {
  it('admits repository-scoped captured bytes through the retained-scope owner', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-captured-repository-' });
    let comparisonId: string | undefined;
    try {
      await writeFile(join(fixture.rootPath, fixture.trackedPath), 'repository capture\n');
      const captured = ScmComparisonCaptureOutputSchema.parse(await executeScmActionOperation({
        actionId: 'scm.diffSummary.capture', workingDirectory: fixture.rootPath,
        input: { cwd: fixture.rootPath, source: { kind: 'workingTree' }, projection: { kind: 'index' } },
      }));
      if (!captured.success) throw new Error(captured.error);
      comparisonId = captured.comparison.id;
      const input = { cwd: fixture.rootPath, captured: { comparisonId, source: { kind: 'workingTree' }, path: fixture.trackedPath } };
      const read = (allow: boolean) => executeScmActionOperation({ actionId: 'scm.diff.file', input,
        workingDirectory: fixture.rootPath, authorizeSession: async scope => scope === undefined && allow });
      expect(await read(true)).toMatchObject({ success: true, diff: expect.stringContaining('+repository capture') });
      expect(await read(false)).toMatchObject({ success: false });
    } finally {
      if (comparisonId) await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId });
      await rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  it('opens retained bytes after worktree mutation and refuses missing, mismatched or denied captures', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-captured-file-' });
    const sessionId = randomUUID();
    const file = join(fixture.rootPath, fixture.trackedPath);
    let comparisonId: string | undefined;
    const execute = (actionId: 'scm.diffSummary.capture' | 'scm.diff.file', input: unknown, allow = true) =>
      executeScmActionOperation({ actionId, input, workingDirectory: fixture.rootPath, authorizeSession: async () => allow });
    try {
      await writeFile(file, 'captured evidence\n');
      const captured = ScmComparisonCaptureOutputSchema.parse(await execute('scm.diffSummary.capture', {
        cwd: fixture.rootPath, sessionId, source: { kind: 'workingTree' }, projection: { kind: 'index' },
      }));
      expect(captured.success).toBe(true);
      if (!captured.success) return;
      comparisonId = captured.comparison.id;
      expect(captured.comparison.inventory.files.find(entry => entry.path === fixture.trackedPath)?.evidence.state).toBe('deferred');
      await writeFile(file, 'later live bytes\n');
      const input = { cwd: fixture.rootPath, captured: { comparisonId, source: { kind: 'workingTree' }, path: file, sessionId } };
      expect(ScmDiffFileRequestSchema.safeParse(input).success).toBe(false);
      const opened = ScmDiffFileResponseSchema.parse(await execute('scm.diff.file', input));
      expect(opened).toMatchObject({ success: true, capturedFile: { path: fixture.trackedPath, evidence: { state: 'available' } } });
      expect(opened.diff).toContain('+captured evidence');
      expect(opened.diff).not.toContain('later live bytes');
      expect((await readCapturedScmComparison({ cwd: fixture.rootPath, comparisonId, sessionId })).comparison.inventory.files
        .find(entry => entry.path === fixture.trackedPath)?.evidence).toMatchObject({ state: 'available', unifiedDiff: opened.diff });
      expect(await execute('scm.diff.file', input, false)).toMatchObject({ success: false });
      expect(await execute('scm.diff.file', { ...input, captured: { ...input.captured, path: 'missing.txt' } })).toMatchObject({ success: false });
      expect(await execute('scm.diff.file', { ...input, captured: { ...input.captured, source: { kind: 'session', sessionId } } })).toMatchObject({ success: false });
      await expect(execute('scm.diff.file', { ...input, path: fixture.trackedPath,
        captured: { ...input.captured, comparisonId: 'invalid' } })).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe('later live bytes\n');
      // A real retained-record boundary fixture models an existing partial source patch.
      const storedPath = join(configuration.activeServerDir, 'runtime', 'scm', 'comparisons',
        encodeRepositoryCheckpointScope(sessionId), `${comparisonId}.json`);
      const stored: unknown = JSON.parse(await readFile(storedPath, 'utf8'));
      const record = z.looseObject({ comparison: ScmComparisonSchema }).parse(stored);
      const partial = record.comparison.inventory.files.find(entry => entry.path === fixture.trackedPath)!;
      partial.evidence = { state: 'unavailable', reason: 'source_patch_truncated', unifiedDiff: opened.diff };
      await writeFile(storedPath, JSON.stringify(record));
      const partialIndex = ScmComparisonCaptureOutputSchema.parse(await execute('scm.diffSummary.capture', {
        cwd: fixture.rootPath, sessionId, comparisonId, source: { kind: 'workingTree' }, projection: { kind: 'index' },
      }));
      expect(partialIndex.success && partialIndex.comparison.inventory.files.find(entry => entry.path === fixture.trackedPath)?.evidence)
        .toEqual({ state: 'deferred', reason: 'source_patch_truncated' });
      expect(await execute('scm.diff.file', input)).toMatchObject({ success: true, diff: opened.diff,
        capturedFile: { evidence: { state: 'unavailable', reason: 'source_patch_truncated', unifiedDiff: opened.diff } } });
      partial.evidence.unifiedDiff = 'x'.repeat(WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES);
      await writeFile(storedPath, JSON.stringify(record));
      expect(await execute('scm.diff.file', input)).toMatchObject({ success: false, errorCode: 'FEATURE_UNSUPPORTED' });
    } finally {
      if (comparisonId) await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId, sessionId });
      await rm(fixture.rootPath, { recursive: true, force: true });
    }
  });
});
