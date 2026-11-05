import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import { ScmComparisonCaptureOutputSchema, ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { ScmDiffSummaryResultResponseSchema } from '@happier-dev/protocol/scm/diffSummaryResult';
import { ScmDiffFileActionRequestSchema, ScmDiffFileRequestSchema, ScmDiffFileResponseSchema } from '@happier-dev/protocol/scm';
import { WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES } from '@happier-dev/protocol/machines/workspaceFiles';
import { createLocalScmRepositoryFixture, runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { createScmHostingProviderRuntimeServicesForTest } from '../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import { configuration } from '@/configuration';
import { encodeRepositoryCheckpointScope } from '../checkpoints/refs';
import { deleteCapturedScmComparison, readCapturedScmComparison } from '../comparisons/captureScmComparison';
import { readStoredScmComparison } from '../comparisons/comparisonStorage';
import { executeScmActionOperation } from './executeScmActionOperation';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';

describe('captured file Action evidence', () => {
  it('reads a staged rename through an explicit selector that legacy file readers refuse', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-rename-read-' });
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.backend.git/git',
      executableDefinition: registration.runtime!, registration,
      hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(),
    })]);
    try {
      const before = Array.from({ length: 30 }, (_, i) => `Fixture line ${i + 1}\n`).join('');
      await writeFile(join(fixture.rootPath, fixture.trackedPath), before);
      runScmExecutable(fixture.rootPath, 'git', ['add', '--', fixture.trackedPath]);
      runScmExecutable(fixture.rootPath, 'git', ['commit', '-m', 'before rename']);
      runScmExecutable(fixture.rootPath, 'git', ['mv', fixture.trackedPath, 'renamed.txt']);
      await writeFile(join(fixture.rootPath, 'renamed.txt'), before.replace('Fixture line 11\n', 'Fixture edited rename line\n'));
      runScmExecutable(fixture.rootPath, 'git', ['add', '--', 'renamed.txt']);
      const wire = { cwd: fixture.rootPath, renamed: { path: 'renamed.txt', previousPath: fixture.trackedPath }, area: 'included' };
      expect(ScmDiffFileRequestSchema.safeParse(wire).success).toBe(false);
      expect(ScmDiffFileActionRequestSchema.safeParse({ ...wire, path: 'renamed.txt' }).success).toBe(false);
      expect(ScmDiffFileActionRequestSchema.safeParse({ ...wire, renamed: { ...wire.renamed, unknown: true } }).success).toBe(false);
      const input = ScmDiffFileActionRequestSchema.parse(wire);
      const reply = ScmDiffFileResponseSchema.parse(await executeScmActionOperation({
        actionId: 'scm.diff.file', workingDirectory: fixture.rootPath, registry, input,
      }));
      if (!reply.success) throw new Error(`${reply.errorCode}: ${reply.error}`);
      expect(reply).toMatchObject({ success: true, diff: expect.stringContaining('-Fixture line 11\n+Fixture edited rename line') });
      expect(reply.diff).not.toContain('+Fixture line 1\n');
    } finally { await rm(fixture.rootPath, { recursive: true, force: true }); }
  });

  it('restores and edits saved results without transferring patches, retaining exact file evidence for pinned reads and undo', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-saved-capture-' });
    const sessionId = randomUUID();
    let comparisonId: string | undefined;
    let resultId: string | undefined;
    let revision = 0;
    try {
      await writeFile(join(fixture.rootPath, fixture.trackedPath), 'saved captured bytes\n');
      const captured = ScmComparisonCaptureOutputSchema.parse(await executeScmActionOperation({
        actionId: 'scm.diffSummary.capture', workingDirectory: fixture.rootPath, authorizeSession: async () => true,
        input: { cwd: fixture.rootPath, sessionId, source: { kind: 'workingTree' } },
      }));
      if (!captured.success) throw new Error(captured.error);
      comparisonId = captured.comparison.id;
      const refs = captured.comparison.inventory.files.flatMap(file => file.occurrences.map(occurrence => occurrence.id));
      const output = ScmDiffSummaryGenerateOutputSchema.parse({ ...captured, sourceKey: comparisonId,
        requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'complete', value: {
          title: 'Saved walkthrough', intro: 'Pinned evidence', stops: [], otherChangeRefs: refs,
        } } }, analysis: { suppliedChangeRefs: refs, analysedChangeRefs: refs, remainingChangeRefs: [] } });
      const saved = await scmDiffSummaryResultStore.create({ cwd: fixture.rootPath, sessionId, output });
      resultId = saved.resultId;
      await writeFile(join(fixture.rootPath, fixture.trackedPath), 'later live bytes\n');
      for (const actionId of ['scm.diffSummary.result.read', 'scm.diffSummary.result.edit', 'scm.diffSummary.result.undo'] as const) {
        const reply = ScmDiffSummaryResultResponseSchema.parse(await executeScmActionOperation({ actionId,
          workingDirectory: fixture.rootPath, sessionId, authorizeSession: async () => true,
          input: { cwd: fixture.rootPath, resultId, ...(actionId === 'scm.diffSummary.result.read' ? {} : { expectedRevision: revision }),
            ...(actionId === 'scm.diffSummary.result.edit' ? { edit: { kind: 'renameWalkthrough', title: 'Edited title' } } : {}) },
        }));
        expect(reply.success).toBe(true);
        if (!reply.success) throw new Error(reply.error);
        revision = reply.result.revision;
        expect(reply.result.output.comparison?.inventory.files.map(file => file.occurrences)).toEqual(captured.comparison.inventory.files.map(file => file.occurrences));
        expect(reply.result.output.comparison?.inventory.files.every(file => file.evidence.state === 'deferred')).toBe(true);
        expect(JSON.stringify(reply)).not.toContain('saved captured bytes');
      }
      const internal = await scmDiffSummaryResultStore.readStoredScope({ cwd: fixture.rootPath, sessionId, resultId });
      expect(internal?.result.output.comparison).toEqual(captured.comparison);
      const opened = ScmDiffFileResponseSchema.parse(await executeScmActionOperation({ actionId: 'scm.diff.file',
        workingDirectory: fixture.rootPath, sessionId, authorizeSession: async () => true,
        input: { cwd: fixture.rootPath, captured: { comparisonId, sessionId, source: captured.comparison.source, path: fixture.trackedPath } },
      }));
      expect(opened).toMatchObject({ success: true, diff: expect.stringContaining('+saved captured bytes') });
      expect(opened.diff).not.toContain('later live bytes');
    } finally {
      if (resultId) await scmDiffSummaryResultStore.delete({ cwd: fixture.rootPath, sessionId, resultId, expectedRevision: revision });
      if (comparisonId) await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId, sessionId });
      await rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

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
      const stored: unknown = await readStoredScmComparison(storedPath);
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
