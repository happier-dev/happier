import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionRunScmDiffSummaryInputV1 } from '@happier-dev/protocol';
import { createRepositoryCheckpointPromptLifecycle } from '@/agent/runtime/checkpoints/repositoryCheckpointPromptLifecycle';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { loadScmDiffSummaryContext } from './loadScmDiffSummaryContext';
import { captureScmComparison, deleteCapturedScmComparison, readCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import { retainRepositoryCheckpointTurnEvidence } from '@/scm/checkpoints/sessionEvidence';
import * as scmRuntime from '@/scm/runtime';
import { buildRepositoryCheckpointInitialRef } from '@/scm/checkpoints/sessionEvidence';
import { encodeRepositoryCheckpointScope } from '@/scm/checkpoints/refs';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';

const repositories: string[] = [];
function git(cwd: string, args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
async function repo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'happier-comparison-context-'));
  repositories.push(cwd);
  git(cwd, ['init']); git(cwd, ['config', 'user.name', 'Comparison Test']); git(cwd, ['config', 'user.email', 'comparison@example.com']);
  await writeFile(join(cwd, 'tracked.txt'), 'initial\n'); git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'initial']);
  return cwd;
}
function input(cwd: string, source: ExecutionRunScmDiffSummaryInputV1['source']): ExecutionRunScmDiffSummaryInputV1 {
  return { cwd, source };
}
describe('loadScmDiffSummaryContext complete comparison evidence', () => {
  afterEach(async () => { vi.restoreAllMocks(); for (const cwd of repositories.splice(0)) await rm(cwd, { recursive: true, force: true }); });
  it('makes every pending file available beyond the former local 40-file ceiling', async () => {
    const cwd = await repo();
    for (let index = 0; index < 45; index++) await writeFile(join(cwd, `untracked-${index}.txt`), `${index}\n`);
    const captured = await loadScmDiffSummaryContext({ workingDirectory: cwd, input: input(cwd, { kind: 'workingTree' }) });
    expect(captured.files).toHaveLength(45);
    expect(captured.files.find((file) => file.path === 'untracked-44.txt')?.unifiedDiff).toContain('+44');
  });
  it('keeps one code basis across repeated capture and distinguishes changed staged layers', async () => {
    const cwd = await repo();
    await writeFile(join(cwd, 'tracked.txt'), 'staged change\n'); git(cwd, ['add', '.']);
    await writeFile(join(cwd, 'tracked.txt'), 'initial\n');
    const first = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
    const repeated = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
    expect(first.comparison.id).toBe(repeated.comparison.id);
    expect(first.comparison.inventory.files).toHaveLength(1);
    expect(first.comparison.inventory.files[0]?.occurrences.map((occurrence) => occurrence.layer)).toEqual(['staged', 'unstaged']);
    expect(git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/happier/checkpoints/'])).toBe('');
    expect(git(cwd, ['for-each-ref', '--format=%(refname)', `refs/happier/comparisons/repository/${first.comparison.id}/`]).split('\n')).toHaveLength(3);
    git(cwd, ['add', '.']);
    const changed = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
    expect(changed.comparison.id).not.toBe(first.comparison.id);
    expect(changed.files).toEqual([]);
  });
  it('retains trusted agent fragments without claiming checkpoint endpoints or inventing blob content', async () => {
    const cwd = await repo(); const sessionId = 'agent-fragments';
    const scopeId = `${sessionId}:${cwd}`;
    const retain = async (unifiedDiff: string) => retainRepositoryCheckpointTurnEvidence({ cwd, scopeId, turnChangeSet: {
      sessionId, turnId: 'turn-agent', provider: 'codex', status: 'completed', derivedAt: 1,
      seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 }, files: [{ filePath: 'fragment.txt', changeKind: 'modified',
        source: 'provider_tool', confidence: 'best_effort', provider: 'codex', unifiedDiff }],
    } });
    await retain('@@ -2 +2 @@\n-old fragment\n+observed fragment\n');
    const source = { kind: 'turnCheckpoint', sessionId, turnId: 'turn-agent', evidenceMode: 'agent_reported' } as const;
    const first = await captureScmComparison({ cwd, source });
    expect(first.files[0]?.unifiedDiff).toContain('+observed fragment');
    expect(first.comparison.endpoints).toEqual({});
    expect(first.comparison.inventory.files[0]?.afterBlobId).toBeUndefined();
    expect(first.metadata.contentConfidence).not.toBe('exact');
    await retain('@@ -2 +2 @@\n-old fragment\n+different observed fragment\n');
    const changed = await captureScmComparison({ cwd, source });
    expect(changed.comparison.id).not.toBe(first.comparison.id);
  });
  it('retains readable staged evidence when the unstaged layer cannot be read', async () => {
    const cwd = await repo(); await writeFile(join(cwd, 'tracked.txt'), 'staged evidence\n'); git(cwd, ['add', '.']);
    const indexOid = git(cwd, ['write-tree']); await writeFile(join(cwd, 'tracked.txt'), 'unreadable later layer\n');
    const command = scmRuntime.runScmCommand;
    // Git process failure is the boundary; comparison enumeration and layer aggregation remain real.
    vi.spyOn(scmRuntime, 'runScmCommand').mockImplementation(async (request) => {
      const fullIndexPosition = request.args.indexOf('--full-index');
      return request.args[0] === 'diff' && fullIndexPosition >= 0 && request.args[fullIndexPosition + 1] === indexOid
        ? { success: false, stdout: '', stderr: 'Unstaged object read failed', exitCode: 1 } : command(request);
    });
    const captured = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
    expect(captured.comparison.inventory.state).toBe('incomplete');
    expect(captured.comparison.inventory.files).toHaveLength(1);
    expect(captured.files[0]?.unifiedDiff).toContain('+staged evidence');
    expect(captured.comparison.inventory.files[0]?.evidence.state).toBe('unavailable');
    expect(captured.comparison.inventory.files[0]?.binary).toBeNull();
    expect(captured.comparison.inventory.files[0]?.occurrences.map((occurrence) => occurrence.evidence?.state)).toEqual(['available', 'unavailable']);
    const unavailableId = captured.comparison.inventory.files[0]?.occurrences[1]?.id;
    vi.restoreAllMocks();
    const recovered = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
    expect(recovered.comparison.id).toBe(captured.comparison.id);
    expect(recovered.comparison.inventory.files[0]?.occurrences.find((occurrence) => occurrence.layer === 'unstaged')?.id).not.toBe(unavailableId);
  });
  it('admits concurrent captures of the same code basis without conflicting endpoint pins', async () => {
    const cwd = await repo(); await writeFile(join(cwd, 'tracked.txt'), 'concurrent capture basis\n');
    const command = scmRuntime.runScmCommand;
    const waiting = new Map<string, { release: () => void; ready: Promise<void> }>();
    // Both actual Git reads observe the missing ref before either capture can pin it.
    vi.spyOn(scmRuntime, 'runScmCommand').mockImplementation(async (request) => {
      const result = await command(request);
      const ref = request.args[2];
      if (request.args[0] === 'rev-parse' && request.args[1] === '--verify' && ref?.startsWith('refs/happier/comparisons/') && ref.endsWith('/before') && !result.success) {
        const previous = waiting.get(ref);
        if (previous) previous.release();
        else {
          let release = () => {};
          const ready = new Promise<void>((resolve) => { release = resolve; });
          waiting.set(ref, { ready, release });
          await ready;
        }
      }
      return result;
    });
    const captured = await Promise.all([captureScmComparison({ cwd, source: { kind: 'workingTree' } }), captureScmComparison({ cwd, source: { kind: 'workingTree' } })]);
    expect(captured[0]?.comparison.id).toBe(captured[1]?.comparison.id);
    expect(captured.every((comparison) => comparison.comparison.inventory.state === 'complete')).toBe(true);
    expect(git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/happier/checkpoints/'])).toBe('');
  });
  it('disposes its temporary checkpoint when canonical endpoint retention fails', async () => {
    const cwd = await repo(); await writeFile(join(cwd, 'tracked.txt'), 'must not orphan capture\n');
    const command = scmRuntime.runScmCommand;
    // The Git write boundary rejects endpoint retention; snapshot creation and cleanup stay real.
    vi.spyOn(scmRuntime, 'runScmCommand').mockImplementation(async (request) => request.args[0] === 'update-ref'
      && request.args[1]?.startsWith('refs/happier/comparisons/')
      ? { success: false, stdout: '', stderr: 'Endpoint retention denied', exitCode: 1 } : command(request));
    await expect(captureScmComparison({ cwd, source: { kind: 'workingTree' } })).rejects.toThrow('Endpoint retention denied');
    expect(git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/happier/checkpoints/'])).toBe('');
  });
  it('loads captured bytes after the live worktree moves and rejects another repository', async () => {
    const cwd = await repo();
    await writeFile(join(cwd, 'tracked.txt'), 'captured\n');
    const captured = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
    await writeFile(join(cwd, 'tracked.txt'), 'later worktree\n');
    const loaded = await readCapturedScmComparison({ cwd, comparisonId: captured.comparison.id, source: { kind: 'workingTree' } });
    expect(loaded.files[0]?.unifiedDiff).toContain('+captured');
    expect(loaded.files[0]?.unifiedDiff).not.toContain('+later worktree');
    const other = await repo();
    await expect(readCapturedScmComparison({ cwd: other, comparisonId: captured.comparison.id })).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
  });
  it('retains the same code identity separately for two authenticated session scopes', async () => {
    const cwd = await repo(); await writeFile(join(cwd, 'tracked.txt'), 'shared basis\n');
    const first = await captureScmComparison({ cwd, source: { kind: 'workingTree' }, sessionId: 'session-a' });
    const second = await captureScmComparison({ cwd, source: { kind: 'workingTree' }, sessionId: 'session-b' });
    expect(first.comparison.id).toBe(second.comparison.id);
    expect((await readCapturedScmComparison({ cwd, comparisonId: first.comparison.id, sessionId: 'session-a' })).files[0]?.unifiedDiff).toContain('+shared basis');
    expect((await readCapturedScmComparison({ cwd, comparisonId: second.comparison.id, sessionId: 'session-b' })).files[0]?.unifiedDiff).toContain('+shared basis');
    await expect(readCapturedScmComparison({ cwd, comparisonId: first.comparison.id, sessionId: 'session-c' })).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
  });
  it('deletes only the selected saved comparison and its owned pins, preserving other sessions and the initial baseline', async () => {
    const cwd = await repo(); const sessionId = 'deletion-session-a';
    const session = createMutableApiSessionClientFixture({ sessionId });
    const lifecycle = createRepositoryCheckpointPromptLifecycle({ session, runtimeDirectory: cwd, provider: 'codex', protocol: 'codex', sessionIsNew: true });
    await lifecycle.onBeforePromptDispatch?.({ messageId: 'first', prompt: 'edit' });
    await writeFile(join(cwd, 'tracked.txt'), 'retained deletion basis\n');
    const first = await captureScmComparison({ cwd, source: { kind: 'workingTree' }, sessionId });
    const second = await captureScmComparison({ cwd, source: { kind: 'workingTree' }, sessionId: 'deletion-session-b' });
    await expect(deleteCapturedScmComparison({ cwd, comparisonId: first.comparison.id, sessionId: 'deletion-session-c' })).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
    await deleteCapturedScmComparison({ cwd, comparisonId: first.comparison.id, sessionId });
    await expect(readCapturedScmComparison({ cwd, comparisonId: first.comparison.id, sessionId })).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
    expect((await readCapturedScmComparison({ cwd, comparisonId: second.comparison.id, sessionId: 'deletion-session-b' })).files[0]?.unifiedDiff).toContain('+retained deletion basis');
    expect(git(cwd, ['for-each-ref', '--format=%(refname)', `refs/happier/comparisons/${encodeRepositoryCheckpointScope(sessionId)}/${first.comparison.id}/`])).toBe('');
    expect(git(cwd, ['show', `${buildRepositoryCheckpointInitialRef(`${sessionId}:${cwd}`)}:tracked.txt`])).toBe('initial');
    await lifecycle.onSessionEnd?.();
  });
  it('captures branch merge-base and a root commit with explicit immutable endpoints', async () => {
    const cwd = await repo(); const root = git(cwd, ['rev-parse', 'HEAD']);
    await writeFile(join(cwd, 'tracked.txt'), 'branch change\n'); git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'branch']);
    const head = git(cwd, ['rev-parse', 'HEAD']);
    const branch = await captureScmComparison({ cwd, source: { kind: 'branch', head, base: root } });
    expect(branch.comparison.endpoints).toEqual({ before: root, after: head });
    expect(branch.files[0]?.unifiedDiff).toContain('+branch change');
    const rootCommit = await captureScmComparison({ cwd, source: { kind: 'commit', commit: root } });
    expect(rootCommit.files[0]?.unifiedDiff).toContain('+initial');
    expect(rootCommit.comparison.inventory.state).toBe('complete');
  });
  it.each([
    { original: 'original.txt', copy: 'copied.txt' },
    { original: 'original [1].txt', copy: 'copied [1] café.txt' },
  ])('isolates copied lineage from its modified source: $copy', async ({ original, copy }) => {
    const cwd = await repo();
    const originalText = Array.from({ length: 20 }, (_, index) => `original line ${index}\n`).join('');
    await writeFile(join(cwd, original), originalText);
    await writeFile(join(cwd, 'original 1.txt'), 'literal sibling before\n');
    git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'copy source']);
    await writeFile(join(cwd, copy), originalText);
    await writeFile(join(cwd, original), originalText.replace('original line 15', 'changed source only'));
    await writeFile(join(cwd, 'original 1.txt'), 'literal sibling after\n');
    git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'copy and modify source']);
    const captured = await captureScmComparison({ cwd, source: { kind: 'commit', commit: 'HEAD' } });
    expect(captured.comparison.inventory.state).toBe('complete');
    const copied = captured.comparison.inventory.files.find((file) => file.path === copy);
    expect(copied).toMatchObject({ previousPath: original, changeKind: 'copied', evidence: { state: 'available' } });
    expect(copied?.evidence.unifiedDiff).not.toContain('changed source only');
    expect(copied?.evidence.unifiedDiff).not.toContain('literal sibling after');
    expect(copied?.evidence.unifiedDiff?.match(/^diff --git /gm)).toHaveLength(1);
    expect(copied?.beforeBlobId).toBe(copied?.afterBlobId);
    expect(copied?.occurrences).toHaveLength(1);
    expect(copied?.occurrences[0]).toMatchObject({ path: copy, previousPath: original,
      before: { startLine: 0, lineCount: 0 }, after: { startLine: 0, lineCount: 0 } });
    expect(captured.files.find((file) => file.path === original)?.unifiedDiff).toContain('+changed source only');
    expect(captured.files.find((file) => file.path === 'original 1.txt')?.unifiedDiff).toContain('+literal sibling after');
  });
  it('captures copied lineage when its source is also renamed', async () => {
    const cwd = await repo();
    git(cwd, ['mv', 'tracked.txt', 'renamed.txt']);
    await writeFile(join(cwd, 'copied.txt'), 'initial\n');
    git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'rename and copy']);
    const captured = await captureScmComparison({ cwd, source: { kind: 'commit', commit: 'HEAD' } });
    expect(captured.comparison.inventory.state).toBe('complete');
    expect(captured.comparison.inventory.files.map((file) => file.changeKind).sort()).toEqual(['copied', 'renamed']);
    for (const file of captured.comparison.inventory.files) {
      expect(file).toMatchObject({ previousPath: 'tracked.txt', evidence: { state: 'available' } });
      expect(file.evidence.unifiedDiff?.match(/^diff --git /gm)).toHaveLength(1);
      expect(file.evidence.unifiedDiff).toContain(`b/${file.path}`);
    }
  });
  it('retains renamed lineage and literal multi-file evidence through public capture', async () => {
    const cwd = await repo();
    const original = 'before [1].txt'; const renamed = 'after [1] café.txt';
    const content = Array.from({ length: 20 }, (_, index) => `rename line ${index}\n`).join('');
    await writeFile(join(cwd, original), content);
    await writeFile(join(cwd, 'before 1.txt'), 'other before\r\n');
    git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'rename source']);
    git(cwd, ['mv', '--', original, renamed]);
    await writeFile(join(cwd, renamed), content.replace('rename line 15', 'renamed change'));
    await writeFile(join(cwd, 'before 1.txt'), 'other after\t \r\n');
    git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'rename and modify']);
    const captured = await captureScmComparison({ cwd, source: { kind: 'commit', commit: 'HEAD' } });
    expect(captured.comparison.inventory.state).toBe('complete');
    const file = captured.comparison.inventory.files.find((entry) => entry.path === renamed);
    expect(file).toMatchObject({ previousPath: original, changeKind: 'renamed', evidence: { state: 'available' } });
    expect(file?.evidence.unifiedDiff).toContain('+renamed change');
    expect(file?.evidence.unifiedDiff).not.toContain('+other after');
    expect(file?.evidence.unifiedDiff?.match(/^diff --git /gm)).toHaveLength(1);
    expect(file?.occurrences).toHaveLength(1);
    expect(file?.occurrences[0]).toMatchObject({ path: renamed, previousPath: original,
      before: { startLine: 13, lineCount: 7 }, after: { startLine: 13, lineCount: 7 } });
    expect(captured.files.find((entry) => entry.path === 'before 1.txt')?.unifiedDiff).toContain('+other after\t \r\n');
  });
  it('captures every delivered pull-request page while preserving missing patch and unknown binary evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-hosted-comparison-')); repositories.push(cwd);
    const baseOid = '1'.repeat(40); const headOid = '2'.repeat(40);
    const configured = createTriageSourceV1Fixture().configuredInstance;
    const source = { kind: 'pullRequest', locator: { providerId: 'github', repository: 'owner/repository', number: 1,
      sourceAction: { action: { pluginId: 'happier.scm.forge.github', localId: 'triage/list-github-changed-files' }, input: { v: 1,
        instance: { ...configured, instance: { ...configured.instance, source: { pluginId: 'happier.scm.forge.github', localId: 'github-forge' } },
          configuration: { v: 1, token: JSON.stringify({ v: 1, scope: { kind: 'repository', repositoryKey: 'owner/repository' } }) } },
        localRef: { kindId: 'pull-request', collisionScope: 'github:4210', entryId: '1' }, routingToken: 'owner/repository', limit: 100,
      } } } } as const;
    const captured = await captureScmComparison({ cwd, source,
      readPullRequestComparisonPage: async ({ continuation }: { continuation?: string }) => ({ kind: 'changedFiles',
        rows: continuation ? [{ path: 'last-missing.txt', status: 'modified', additions: 0, deletions: 0, changes: 0, diffAvailable: false,
          evidence: { state: 'unavailable', reason: 'provider_patch_missing' } }]
          : Array.from({ length: 100 }, (_, index) => ({ path: `file-${index}.txt`, status: 'modified', additions: 1, deletions: 1, changes: 2,
            diffAvailable: true, evidence: { state: 'available', patch: '@@ -1 +1 @@\n-old\n+observed\n' } })),
        omittedRowCount: 0, projectionTruncated: false, ...(continuation ? {} : { continuation: 'source-page-2' }),
        comparison: { beforeOid: baseOid, baseOid, headOid, totalFileCount: 101, enumeratedFileCount: continuation ? 101 : 100,
          locator: { providerId: 'github', repository: 'owner/repository', number: 1 },
          freshness: 'current', inventory: continuation ? 'complete' : 'incomplete', content: continuation ? 'incomplete' : 'complete',
          reasons: continuation ? ['provider_patch_missing'] : [] },
      }),
    });
    expect(captured.comparison.endpoints).toEqual({ before: baseOid, after: headOid });
    expect(captured.files).toHaveLength(101);
    expect(captured.files[0]?.unifiedDiff).toContain('--- a/file-0.txt\n+++ b/file-0.txt\n@@');
    expect(captured.comparison.inventory.state).toBe('incomplete');
    expect(captured.comparison.inventory.files.at(-1)).toMatchObject({ path: 'last-missing.txt', binary: null,
      evidence: { state: 'unavailable', reason: 'provider_patch_missing' } });
    const readCompletePage = async ({ continuation }: { continuation?: string }) => ({ kind: 'changedFiles',
      rows: Array.from({ length: continuation ? 1 : 100 }, (_, index) => ({ path: `complete-${continuation ? 100 : index}.txt`,
        status: 'modified', additions: 1, deletions: 1, changes: 2, diffAvailable: true,
        evidence: { state: 'available', patch: '@@ -1 +1 @@\n-old\n+fully observed\n' } })),
      omittedRowCount: 0, projectionTruncated: false, ...(continuation ? {} : { continuation: 'complete-page-2' }),
      comparison: { beforeOid: '3'.repeat(40), baseOid: '3'.repeat(40), headOid: '4'.repeat(40), totalFileCount: 101, enumeratedFileCount: continuation ? 101 : 100,
        locator: { providerId: 'github', repository: 'owner/repository', number: 1 },
        freshness: 'current', inventory: continuation ? 'complete' : 'incomplete', content: 'complete', reasons: continuation ? [] : ['pages_pending'] },
    });
    const complete = await captureScmComparison({ cwd, source, readPullRequestComparisonPage: readCompletePage });
    expect(complete.comparison.inventory.state).toBe('complete');
    expect(complete.files).toHaveLength(101);
    expect((await readCapturedScmComparison({ cwd, comparisonId: complete.comparison.id, source })).files[0]?.unifiedDiff).toContain('+fully observed');
    expect((await readCapturedScmComparison({ cwd, comparisonId: complete.comparison.id,
      source: { ...source, locator: { ...source.locator, baseOid: '3'.repeat(40), headOid: '4'.repeat(40) } } })).comparison.endpoints)
      .toEqual({ before: '3'.repeat(40), after: '4'.repeat(40) });
    await expect(readCapturedScmComparison({ cwd, comparisonId: complete.comparison.id,
      source: { ...source, locator: { ...source.locator, baseOid: '9'.repeat(40) } } })).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
    const refreshedSource = { ...source, locator: { ...source.locator, sourceAction: { ...source.locator.sourceAction,
      input: { ...source.locator.sourceAction.input, continuation: 'obsolete-client-routing-token' } } } };
    const refreshed = await captureScmComparison({ cwd, source: refreshedSource, readPullRequestComparisonPage: readCompletePage });
    expect(refreshed.comparison.id).toBe(complete.comparison.id);
    expect((await readCapturedScmComparison({ cwd, comparisonId: complete.comparison.id, source })).files).toHaveLength(101);
    await expect(readCapturedScmComparison({ cwd, comparisonId: complete.comparison.id,
      source: { ...source, locator: { ...source.locator, number: 2 } } })).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
    for (const locator of [undefined, { providerId: 'github', repository: 'another/repository', number: 4 }]) {
      const unproved = await captureScmComparison({ cwd, source, readPullRequestComparisonPage: async () => ({ kind: 'changedFiles',
        rows: [{ path: 'wrongly-labelled.txt', status: 'modified', diffAvailable: true, evidence: { state: 'available', patch: '@@ -1 +1 @@\n-old\n+unproved source\n' } }],
        omittedRowCount: 0, projectionTruncated: false, comparison: { beforeOid: baseOid, baseOid, headOid, ...(locator ? { locator } : {}),
          totalFileCount: 1, enumeratedFileCount: 1, freshness: 'current', inventory: 'complete', content: 'complete', reasons: [] },
      }) });
      expect(unproved.comparison.inventory.state).toBe(locator ? 'unavailable' : 'incomplete');
      if (locator) expect(unproved.files).toEqual([]);
    }
    for (const gap of ['changedEndpoint', 'failedPage', 'repeatedContinuation', 'countMismatch', 'truncatedPatch']) {
      const retained = await captureScmComparison({ cwd, source, readPullRequestComparisonPage: async ({ continuation }) => {
        if (continuation && gap === 'failedPage') throw new Error('Source page transport failed');
        const final = gap === 'countMismatch' || gap === 'truncatedPatch' || !!continuation;
        return { kind: 'changedFiles', rows: [{ path: continuation ? 'second.txt' : 'first.txt', status: 'modified', diffAvailable: true,
          evidence: gap === 'truncatedPatch' ? { state: 'truncated', patch: '@@ -1 +1 @@\n-old\n+retained partial\n', reason: 'provider_patch_truncated' }
            : { state: 'available', patch: '@@ -1 +1 @@\n-old\n+retained supplied\n' } }],
          omittedRowCount: 0, projectionTruncated: false,
          ...(!final || gap === 'repeatedContinuation' ? { continuation: 'source-next' } : {}),
          comparison: { beforeOid: baseOid, baseOid, headOid: continuation && gap === 'changedEndpoint' ? '5'.repeat(40) : headOid,
            locator: { providerId: 'github', repository: 'owner/repository', number: 1 },
            totalFileCount: gap === 'countMismatch' || gap === 'truncatedPatch' ? 1 : 2,
            enumeratedFileCount: gap === 'countMismatch' ? 200 : continuation ? 2 : 1,
            freshness: 'current', inventory: final ? 'complete' : 'incomplete', content: 'complete', reasons: [] },
        };
      } });
      expect(retained.comparison.inventory.state).toBe('incomplete');
      expect(retained.files[0]?.unifiedDiff).toContain(gap === 'truncatedPatch' ? '+retained partial' : '+retained supplied');
      if (gap === 'changedEndpoint' || gap === 'failedPage') expect(retained.files).toHaveLength(1);
      if (gap === 'truncatedPatch') expect(retained.comparison.inventory.files[0]?.occurrences[0]?.evidence?.state).toBe('unavailable');
    }
  });
  it('resolves trusted turn receipts and ignores caller fabricated file evidence', async () => {
    const cwd = await repo();
    const session = createMutableApiSessionClientFixture({ overrides: { sessionId: 'trusted-turn' } });
    const lifecycle = createRepositoryCheckpointPromptLifecycle({ session, runtimeDirectory: cwd, provider: 'codex', protocol: 'codex' });
    await lifecycle.onBeforePromptDispatch?.({ messageId: 'first', prompt: 'edit' });
    await lifecycle.onTurnStarted?.({ messageId: 'first', turnId: 'turn-1', sequence: 1 });
    await writeFile(join(cwd, 'tracked.txt'), 'trusted\n');
    await lifecycle.onTurnFinal?.({ messageId: 'first', turnId: 'turn-1', status: 'completed', sequence: 2 });
    const captured = await loadScmDiffSummaryContext({ workingDirectory: cwd, input: {
      cwd, source: { kind: 'turnCheckpoint', sessionId: session.sessionId, turnId: 'turn-1' },
      turnChangeSet: { sessionId: session.sessionId, turnId: 'turn-1', status: 'completed', provider: 'codex', derivedAt: 1,
        seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 }, files: [{ filePath: 'forged.txt', changeKind: 'added',
          unifiedDiff: '@@ -0,0 +1 @@\n+forged\n', source: 'scm_checkpoint', confidence: 'exact', provider: 'codex' }] },
    } });
    expect(captured.files.map((file) => file.path)).toEqual(['tracked.txt']);
    expect(captured.files[0]?.unifiedDiff).toContain('+trusted');
    const receiptOnly = await captureScmComparison({ cwd, source: { kind: 'turnCheckpoint', sessionId: session.sessionId, checkpointReceiptId: 'checkpoint.diff_computed' } });
    expect(receiptOnly.metadata.turnId).toBe('turn-1');
    expect(receiptOnly.files[0]?.unifiedDiff).toContain('+trusted');
    const mismatched = await captureScmComparison({ cwd, source: { kind: 'turnCheckpoint', sessionId: 'other', turnId: 'turn-1' } });
    expect(mismatched.comparison.inventory.state).toBe('unavailable');
    await expect(captureScmComparison({ cwd, sessionId: session.sessionId, source: { kind: 'session', sessionId: 'other' } })).rejects.toMatchObject({ code: 'CHECKPOINT_NOT_FOUND' });
    await lifecycle.onSessionEnd?.();
  });
  it('compares an immutable commit to its parent rather than current pending files', async () => {
    const cwd = await repo();
    await writeFile(join(cwd, 'tracked.txt'), 'committed change\n'); git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'change']);
    const commit = git(cwd, ['rev-parse', 'HEAD']);
    await writeFile(join(cwd, 'pending.txt'), 'different pending evidence\n');
    const captured = await loadScmDiffSummaryContext({ workingDirectory: cwd, input: input(cwd, { kind: 'commit', commit }) });
    expect(captured.files.map((file) => file.path)).toEqual(['tracked.txt']);
    expect(captured.files[0]?.unifiedDiff).toContain('+committed change');
  });
  it('uses the initial dirty snapshot for session net across edit, commit, resume and reversion', async () => {
    const cwd = await repo();
    const session = createMutableApiSessionClientFixture({ overrides: { sessionId: 'session-net' } });
    const makeLifecycle = () => createRepositoryCheckpointPromptLifecycle({ session, runtimeDirectory: cwd, provider: 'codex', protocol: 'codex', sessionIsNew: true });
    let lifecycle = makeLifecycle();
    await writeFile(join(cwd, 'tracked.txt'), 'pre-existing dirt\n');
    await lifecycle.onBeforePromptDispatch?.({ messageId: 'first', prompt: 'edit' });
    await lifecycle.onTurnStarted?.({ messageId: 'first', turnId: 'turn-1', sequence: 1 });
    await writeFile(join(cwd, 'tracked.txt'), 'agent changed\n');
    await lifecycle.onTurnFinal?.({ messageId: 'first', turnId: 'turn-1', status: 'completed', sequence: 2 });
    git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'user commit']);
    await lifecycle.onSessionEnd?.(); lifecycle = makeLifecycle();
    await lifecycle.onBeforePromptDispatch?.({ messageId: 'second', prompt: 'revert' });
    await writeFile(join(cwd, 'tracked.txt'), 'pre-existing dirt\n');
    const captured = await loadScmDiffSummaryContext({ workingDirectory: cwd, input: input(cwd, { kind: 'session', sessionId: session.sessionId }) });
    expect(captured.files).toEqual([]);
    await lifecycle.onSessionEnd?.();
  });
});
