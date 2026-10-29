import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { configuration } from '@/configuration';
import { createScmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { applyScmReviewedMarkIntent, isScmSelectionReviewed } from '@happier-dev/protocol/scm/reviewedMarks';
import { buildScmReviewScopeId } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { retainRepositoryCheckpointTurnEvidence } from '../checkpoints/sessionEvidence';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { encodeRepositoryCheckpointScope } from '../checkpoints/refs';
import { captureScmComparison, deleteCapturedScmComparison, prepareCapturedScmComparisonInvestigation, readCapturedScmComparison } from './captureScmComparison';

describe('captured SCM comparison storage', () => {
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

  it('captures exact immutable endpoints and their net diff without substituting a merge base or HEAD', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-exact-range-' });
    directories.push(fixture.rootPath);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture.rootPath, encoding: 'utf8' }).trim();
    await writeFile(join(fixture.rootPath, 'before-only.txt'), 'before side\n');
    git('add', '.'); git('commit', '-m', 'before branch');
    const before = git('rev-parse', 'HEAD');
    git('checkout', '--detach', fixture.headCommit);
    await writeFile(join(fixture.rootPath, 'net-zero.txt'), 'intermediate\n');
    git('add', '.'); git('commit', '-m', 'intermediate');
    await rm(join(fixture.rootPath, 'net-zero.txt'));
    await writeFile(join(fixture.rootPath, 'after-only.txt'), 'after side\n');
    git('add', '-A'); git('commit', '-m', 'after branch');
    const after = git('rev-parse', 'HEAD');
    await writeFile(join(fixture.rootPath, 'head-only.txt'), 'later HEAD\n');
    git('add', '.'); git('commit', '-m', 'later HEAD');
    const captured = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'revisionRange', baseOid: before, headOid: after } });
    try {
      expect(captured.comparison.endpoints).toEqual({ before, after });
      expect(captured.comparison.inventory.state).toBe('complete');
      expect(captured.comparison.inventory.files.map(file => file.path).sort()).toEqual(['after-only.txt', 'before-only.txt']);
      expect(captured.comparison.inventory.files.find(file => file.path === 'before-only.txt')?.changeKind).toBe('deleted');
    } finally { await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId: captured.comparison.id }); }
  });

  it('does not claim complete range coverage when an immutable endpoint is missing', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-missing-range-' });
    directories.push(fixture.rootPath);
    const captured = await captureScmComparison({ cwd: fixture.rootPath,
      source: { kind: 'revisionRange', baseOid: 'f'.repeat(40), headOid: fixture.headCommit } });
    try {
      expect(captured.comparison.inventory.state).toBe('unavailable');
      expect(captured.comparison.inventory.files).toEqual([]);
      expect(captured.comparison.inventory.reasons.length).toBeGreaterThan(0);
    } finally { await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId: captured.comparison.id }); }
  });

  it('does not demand-fetch missing promisor blobs while capturing an exact revision range', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-range-no-fetch-' });
    directories.push(fixture.rootPath);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture.rootPath, encoding: 'utf8' }).trim();
    const before = fixture.headCommit;
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Only the promisor has these endpoint bytes\n');
    git('add', '.'); git('commit', '-m', 'promised endpoint');
    const after = git('rev-parse', 'HEAD');
    const missingBlob = git('rev-parse', `${after}:${fixture.trackedPath}`);
    const origin = join(fixture.rootPath, 'origin.git');
    const checkout = join(fixture.rootPath, 'partial-checkout');
    git('clone', '--bare', '--no-local', fixture.rootPath, origin);
    git('-C', origin, 'config', 'uploadpack.allowFilter', 'true');
    git('clone', '--filter=blob:none', '--no-checkout', pathToFileURL(origin).href, checkout);
    const hasBlob = () => spawnSync('git', ['cat-file', '-e', missingBlob], { cwd: checkout,
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, stdio: 'pipe' }).status === 0;
    expect(hasBlob(), 'The real filtered clone must not already contain the endpoint blob').toBe(false);
    const captured = await captureScmComparison({ cwd: checkout, source: { kind: 'revisionRange', baseOid: before, headOid: after } });
    try {
      expect(captured.comparison.endpoints).toEqual({ before, after });
      expect({ complete: captured.comparison.inventory.state === 'complete', blobAcquired: hasBlob() })
        .toEqual({ complete: false, blobAcquired: false });
      expect(captured.comparison.inventory.reasons.length).toBeGreaterThan(0);
    } finally { await deleteCapturedScmComparison({ cwd: checkout, comparisonId: captured.comparison.id }); }
  });

  it('returns typed unavailable for a missing Session baseline instead of capturing the current worktree', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-session-no-baseline-' });
    directories.push(fixture.rootPath);
    const sessionId = randomUUID();
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'current worktree is not the historical baseline\n');
    await writeFile(join(fixture.rootPath, 'late-only.txt'), 'uncaptured file\n');
    const captured = await captureScmComparison({ cwd: fixture.rootPath, sessionId, source: { kind: 'session', sessionId },
      readTranscriptPage: async () => ({ messages: [], hasMore: false, nextAfterSeq: null }) });
    try {
      expect(captured.comparison.endpoints).toEqual({});
      expect(captured.comparison.inventory).toMatchObject({ state: 'unavailable', files: [] });
      expect(captured.comparison.inventory.reasons).not.toHaveLength(0);
      expect(captured.metadata.contentConfidence).toBe('unavailable');
      expect(captured.files).toEqual([]);
      await writeFile(join(fixture.rootPath, fixture.trackedPath), 'another current edit\n');
      expect(await readCapturedScmComparison({ cwd: fixture.rootPath, sessionId, comparisonId: captured.comparison.id })).toEqual(captured);
    } finally { await deleteCapturedScmComparison({ cwd: fixture.rootPath, sessionId, comparisonId: captured.comparison.id }); }
  });

  it('lets a Session investigate a Machine capture without exposing another Session capture', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-machine-review-' });
    directories.push(fixture.rootPath);
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Machine change\n');
    const machine = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' } });
    const sessionId = randomUUID();
    const investigationDirectory = join(configuration.activeServerDir, 'tmp', randomUUID());
    directories.push(investigationDirectory);
    try {
      expect(await readCapturedScmComparison({ cwd: fixture.rootPath, sessionId, comparisonId: machine.comparison.id }))
        .toEqual(machine);
      const pinned = await prepareCapturedScmComparisonInvestigation({ cwd: fixture.rootPath, sessionId,
        comparisonId: machine.comparison.id, directory: investigationDirectory });
      expect(await readFile(join(pinned.afterDirectory, fixture.trackedPath), 'utf8')).toBe('Machine change\n');
      await expect(readCapturedScmComparison({ cwd: fixture.rootPath, sessionId,
        comparisonId: machine.comparison.id, source: { kind: 'commit', commit: 'HEAD' } }))
        .rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
      const scoped = await captureScmComparison({ cwd: fixture.rootPath, sessionId, source: { kind: 'workingTree' } });
      expect(scoped.comparison.id).toBe(machine.comparison.id);
      const scopedPath = join(configuration.activeServerDir, 'runtime', 'scm', 'comparisons',
        encodeRepositoryCheckpointScope(sessionId), `${scoped.comparison.id}.json`);
      const content = await readFile(scopedPath, 'utf8');
      try {
        const stored = JSON.parse(content) as Record<string, unknown>;
        delete stored.sessionId;
        await writeFile(scopedPath, JSON.stringify(stored));
        await expect(readCapturedScmComparison({ cwd: fixture.rootPath, sessionId, comparisonId: scoped.comparison.id }))
          .rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
        await writeFile(scopedPath, '{');
        await expect(readCapturedScmComparison({ cwd: fixture.rootPath, sessionId, comparisonId: scoped.comparison.id }))
          .rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
      } finally {
        await writeFile(scopedPath, content);
        await deleteCapturedScmComparison({ cwd: fixture.rootPath, sessionId, comparisonId: scoped.comparison.id });
      }
      await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Private change\n');
      const privateCapture = await captureScmComparison({ cwd: fixture.rootPath, sessionId, source: { kind: 'workingTree' } });
      try {
        await expect(readCapturedScmComparison({ cwd: fixture.rootPath, sessionId: randomUUID(),
          comparisonId: privateCapture.comparison.id })).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
      } finally { await deleteCapturedScmComparison({ cwd: fixture.rootPath, sessionId, comparisonId: privateCapture.comparison.id }); }
    } finally { await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId: machine.comparison.id }); }
  });

  it('isolates reviewed content by resolved turn selectors in new and retained captures', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-review-turn-scope-' });
    directories.push(fixture.rootPath);
    const captures = [];
    for (const [sessionId, turnId] of [[randomUUID(), 'turn-1'], [randomUUID(), 'turn-1']] as const) {
      for (const selectedTurn of [turnId, 'turn-2']) {
        await retainRepositoryCheckpointTurnEvidence({ cwd: fixture.rootPath, scopeId: `${sessionId}:${fixture.rootPath}`, turnChangeSet: {
          sessionId, turnId: selectedTurn, seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 }, status: 'completed',
          provider: 'agent', derivedAt: 1, files: [{ filePath: fixture.trackedPath, changeKind: 'modified',
            source: 'provider_tool', confidence: 'exact', provider: 'agent', unifiedDiff: '@@ -1 +1 @@\n-before\n+after\n' }],
        } });
        captures.push({ sessionId, ...await captureScmComparison({ cwd: fixture.rootPath, sessionId, turnId: selectedTurn,
          turnEvidenceMode: 'agent_reported', source: { kind: 'turnCheckpoint' } }) });
      }
    }
    try {
      const first = captures[0]!;
      const scope = (comparison: typeof first.comparison) => buildScmReviewScopeId({ repositoryRootPath: comparison.repository.rootPath, source: comparison.source });
      const refs = first.comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.id));
      expect(refs).not.toHaveLength(0);
      const record = applyScmReviewedMarkIntent(first.comparison, null, refs, true);
      expect(new Set(captures.map(capture => scope(capture.comparison))).size).toBe(4);
      for (const captured of captures.slice(1)) {
        expect(isScmSelectionReviewed(record, captured.comparison,
          captured.comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.id)))).toBe(false);
      }
      // A pre-normalization retained capture stores selectors in metadata/session, not source.
      const path = join(configuration.activeServerDir, 'runtime', 'scm', 'comparisons',
        encodeRepositoryCheckpointScope(first.sessionId), `${first.comparison.id}.json`);
      const stored = JSON.parse(await readFile(path, 'utf8')) as { comparison: typeof first.comparison; metadata: typeof first.metadata };
      stored.comparison.source = { kind: 'turnCheckpoint' };
      stored.metadata.source = { kind: 'turnCheckpoint' };
      await writeFile(path, JSON.stringify(stored));
      const retained = await readCapturedScmComparison({ cwd: fixture.rootPath, sessionId: first.sessionId, comparisonId: first.comparison.id });
      expect(retained.comparison.id).toBe(first.comparison.id);
      expect(retained.comparison.inventory).toEqual(first.comparison.inventory);
      expect(scope(retained.comparison)).toBe(scope(first.comparison));
      expect(isScmSelectionReviewed(record, retained.comparison, refs)).toBe(true);
      await expect(readCapturedScmComparison({ cwd: fixture.rootPath, sessionId: first.sessionId,
        comparisonId: first.comparison.id, source: { kind: 'turnCheckpoint', sessionId: 'foreign-session' } }))
        .rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
      const directory = join(fixture.rootPath, 'saved-results');
      const store = createScmDiffSummaryResultStore({ directory });
      const created = await store.create({ cwd: fixture.rootPath, sessionId: first.sessionId, output: {
        success: true, sourceKey: first.comparison.id, metadata: first.metadata, comparison: first.comparison,
        analysis: { suppliedChangeRefs: refs, analysedChangeRefs: refs, remainingChangeRefs: [] },
        requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'complete', value: {
          title: 'Original', intro: 'Inspect the change', stops: [{ id: 'stop', title: 'Change', explanationMarkdown: 'Inspect', changeRefs: refs }], otherChangeRefs: [],
        } } },
      } });
      const request = { cwd: fixture.rootPath, sessionId: first.sessionId, resultId: created.resultId };
      const edited = await store.edit({ ...request, expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'Edited' } });
      if (!edited.success) throw new Error(edited.error);
      const savedPath = join(directory, `${created.resultId}.json`);
      const saved = JSON.parse(await readFile(savedPath, 'utf8')) as { result: typeof created; undoOutput: typeof created.output };
      for (const output of [saved.result.output, saved.undoOutput]) {
        output.comparison!.source = { kind: 'turnCheckpoint' };
        output.metadata!.source = { kind: 'turnCheckpoint' };
      }
      await writeFile(savedPath, JSON.stringify(saved));
      expect(await store.list()).toMatchObject({ results: [{ source: first.comparison.source }] });
      for (const result of [await store.read(request), await store.undo({ ...request, expectedRevision: 1 })]) {
        if (!result.success) throw new Error(result.error);
        expect(result.result.output.comparison?.id).toBe(first.comparison.id);
        expect(result.result.output.comparison?.source).toEqual(first.comparison.source);
        expect(isScmSelectionReviewed(record, result.result.output.comparison!, refs)).toBe(true);
      }
    } finally {
      await Promise.all(captures.map(capture => deleteCapturedScmComparison({ cwd: fixture.rootPath,
        sessionId: capture.sessionId, comparisonId: capture.comparison.id })));
    }
  });

  it('preserves legacy occurrence ids byte for byte on real Git multi-hunk and metadata evidence', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-hunk-id-vectors-' });
    directories.push(fixture.rootPath);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture.rootPath, encoding: 'utf8' });
    const before = '\ufeff' + Array.from({ length: 35 }, (_, index) => `line ${index + 1}\r\n`).join('');
    await writeFile(join(fixture.rootPath, fixture.trackedPath), before);
    await writeFile(join(fixture.rootPath, 'deleted.txt'), 'removed\n');
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'id vectors');
    await writeFile(join(fixture.rootPath, fixture.trackedPath), before.replace('line 3\r\n', 'first edit\r\n').replace('line 30\r\n', 'last edit\r\n'));
    await rm(join(fixture.rootPath, 'deleted.txt'));
    await writeFile(join(fixture.rootPath, 'added.txt'), 'no final newline');
    await writeFile(join(fixture.rootPath, 'binary.dat'), Buffer.from([0, 1, 2]));
    const captured = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' } });
    try {
      expect(captured.comparison.inventory.files.find(file => file.path === fixture.trackedPath)?.occurrences).toHaveLength(2);
      for (const file of captured.comparison.inventory.files) {
        // The pre-consolidation capture contract, checked against real Git output.
        const headers = [...(file.evidence.unifiedDiff ?? '').matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)];
        expect(file.occurrences.map(occurrence => occurrence.id)).toEqual((headers.length ? headers : [null]).map((header, position) => {
          const before = { startLine: header ? Number(header[1]) : 0, lineCount: header ? Number(header[2] ?? 1) : 0 };
          const after = { startLine: header ? Number(header[3]) : 0, lineCount: header ? Number(header[4] ?? 1) : 0 };
          return `${captured.comparison.id}:${JSON.stringify([file.path, file.previousPath ?? null,
            file.occurrences[position]!.layer ?? 'combined', header ? 'hunk' : 'metadata', 'available', before, after, position])}`;
        }));
      }
    } finally { await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId: captured.comparison.id }); }
  });

  it('captures and materializes the same raw endpoint when replacement refs predate capture', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-raw-capture-' });
    directories.push(fixture.rootPath);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture.rootPath, encoding: 'utf8' }).trim();
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Actual endpoint\n');
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'actual endpoint');
    const original = git('rev-parse', `HEAD:${fixture.trackedPath}`);
    await writeFile(join(fixture.rootPath, 'replacement.txt'), 'Forged endpoint\n');
    git('replace', original, git('hash-object', '-w', 'replacement.txt'));
    const captured = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'commit', commit: 'HEAD' } });
    try {
      const diff = captured.comparison.inventory.files.find(file => file.path === fixture.trackedPath)?.evidence.unifiedDiff;
      expect(diff).toContain('+Actual endpoint');
      expect(diff).not.toContain('Forged endpoint');
      const pinned = await prepareCapturedScmComparisonInvestigation({ cwd: fixture.rootPath,
        comparisonId: captured.comparison.id, directory: join(fixture.rootPath, 'investigation') });
      expect(await readFile(join(pinned.afterDirectory, fixture.trackedPath), 'utf8')).toBe('Actual endpoint\n');
    } finally { await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId: captured.comparison.id }); }
  });

  it('refuses a redirected investigation root before materializing captured objects', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-pinned-root-' });
    directories.push(fixture.rootPath);
    const captured = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' } });
    const outside = join(fixture.rootPath, 'outside');
    await mkdir(outside);
    const root = join(fixture.rootPath, 'owned-investigation');
    await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await expect(prepareCapturedScmComparisonInvestigation({ cwd: fixture.rootPath,
        comparisonId: captured.comparison.id, directory: root })).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
      expect(await readdir(outside)).toEqual([]);
    } finally { await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId: captured.comparison.id }); }
  });

  it('refuses retained replacement-influenced evidence rather than combining it with raw endpoint files', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-retained-replacement-' });
    directories.push(fixture.rootPath);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture.rootPath, encoding: 'utf8' }).trim();
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Actual endpoint\n');
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'actual endpoint');
    const sessionId = randomUUID();
    const scope = { cwd: fixture.rootPath, sessionId };
    const captured = await captureScmComparison({ ...scope, source: { kind: 'commit', commit: 'HEAD' } });
    await writeFile(join(fixture.rootPath, 'replacement.txt'), 'Forged endpoint\n');
    git('replace', git('rev-parse', `HEAD:${fixture.trackedPath}`), git('hash-object', '-w', 'replacement.txt'));
    // Real pre-fix Git output, persisted through the existing storage boundary.
    const legacyPatch = git('diff', '--no-ext-diff', '--no-textconv', '--no-color', '--raw', '--no-abbrev', '-z',
      '--find-renames', '--find-copies', '--patch', '--binary', '--full-index', captured.comparison.endpoints.before!,
      captured.comparison.endpoints.after!, '--', `:(literal)${fixture.trackedPath}`) + '\n';
    expect(legacyPatch).toContain('+Forged endpoint');
    const directory = join(configuration.activeServerDir, 'runtime', 'scm', 'comparisons', encodeRepositoryCheckpointScope(sessionId));
    directories.push(directory);
    const path = join(directory, `${captured.comparison.id}.json`);
    const stored = JSON.parse(await readFile(path, 'utf8')) as { comparison: typeof captured.comparison };
    const legacy = stored.comparison.inventory.files.find(file => file.path === fixture.trackedPath)!;
    legacy.evidence = { state: 'available', unifiedDiff: legacyPatch.slice(legacyPatch.indexOf('diff --git ')) };
    await writeFile(path, JSON.stringify(stored));
    git('replace', '-d', git('rev-parse', `HEAD:${fixture.trackedPath}`));
    try {
      expect((await readCapturedScmComparison({ ...scope, comparisonId: captured.comparison.id })).files[0]?.unifiedDiff)
        .toContain('Forged endpoint');
      await expect(prepareCapturedScmComparisonInvestigation({ ...scope, comparisonId: captured.comparison.id,
        directory: join(fixture.rootPath, 'investigation') })).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
    } finally { await deleteCapturedScmComparison({ ...scope, comparisonId: captured.comparison.id }); }
  });

  it.each(['before', 'after'] as const)('investigates a valid retained capture with native zero diff context set %s capture', async when => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-retained-diff-context-' });
    directories.push(fixture.rootPath);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture.rootPath, encoding: 'utf8' }).trim();
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'First\nOld\nLast\n');
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'context');
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'First\nNew\nLast\n');
    if (when === 'before') git('config', 'diff.context', '0');
    const captured = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' } });
    if (when === 'after') git('config', 'diff.context', '0');
    try {
      const pinned = await prepareCapturedScmComparisonInvestigation({ cwd: fixture.rootPath,
        comparisonId: captured.comparison.id, directory: join(fixture.rootPath, 'investigation') });
      expect(await readFile(join(pinned.beforeDirectory, fixture.trackedPath), 'utf8')).toBe('First\nOld\nLast\n');
      expect(await readFile(join(pinned.afterDirectory, fixture.trackedPath), 'utf8')).toBe('First\nNew\nLast\n');
    } finally { await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId: captured.comparison.id }); }
  });

  it('investigates a captured copy whose source also changes in the same staged endpoint', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-retained-copy-' });
    directories.push(fixture.rootPath);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture.rootPath, encoding: 'utf8' }).trim();
    const original = Array.from({ length: 100 }, (_, index) => `Line ${index}\n`).join('');
    await writeFile(join(fixture.rootPath, fixture.trackedPath), original);
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'copy source');
    await writeFile(join(fixture.rootPath, 'copy.txt'), original);
    await writeFile(join(fixture.rootPath, fixture.trackedPath), original.replace('Line 0\n', 'Changed\n'));
    git('add', '.');
    const captured = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' } });
    expect(captured.comparison.inventory.files.find(file => file.path === 'copy.txt')?.changeKind).toBe('copied');
    try {
      const pinned = await prepareCapturedScmComparisonInvestigation({ cwd: fixture.rootPath,
        comparisonId: captured.comparison.id, directory: join(fixture.rootPath, 'investigation') });
      expect(await readFile(join(pinned.afterDirectory, 'copy.txt'), 'utf8')).toBe(original);
      expect(await readFile(join(pinned.afterDirectory, fixture.trackedPath), 'utf8')).toContain('Changed');
    } finally { await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId: captured.comparison.id }); }
  });

  it('reads recursive stored extras, preserves identity constraints and canonically rewrites before owned pin deletion', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-stored-comparison-' });
    directories.push(fixture.rootPath);
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Changed\n');
    const sessionId = randomUUID();
    const captured = await captureScmComparison({ cwd: fixture.rootPath, sessionId, source: { kind: 'workingTree' } });
    const scope = { cwd: fixture.rootPath, sessionId, comparisonId: captured.comparison.id };
    const directory = join(configuration.activeServerDir, 'runtime', 'scm', 'comparisons', encodeRepositoryCheckpointScope(sessionId));
    directories.push(directory);
    const path = join(directory, `${scope.comparisonId}.json`);
    const original = JSON.parse(await readFile(path, 'utf8')) as { retainedRefs: { ref: string; oid: string }[] };
    const stored = { ...original, sessionId, future: true,
      metadata: { ...captured.metadata, future: true, source: { ...captured.metadata.source, future: true } },
      comparison: { ...captured.comparison, future: true, repository: { ...captured.comparison.repository, future: true },
        inventory: { ...captured.comparison.inventory, future: true, files: captured.comparison.inventory.files.map(file => ({ ...file,
          evidence: { ...file.evidence, future: true }, occurrences: file.occurrences.map(occurrence => ({ ...occurrence,
            future: true, before: { ...occurrence.before, future: true } })),
        })) } },
      retainedRefs: original.retainedRefs.map(ref => ({ ...ref, future: true })),
    };
    await writeFile(path, JSON.stringify(stored));
    expect(await readCapturedScmComparison(scope)).toEqual(captured);
    await expect(readCapturedScmComparison({ ...scope, cwd: '/another-repository' })).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
    await expect(readCapturedScmComparison({ ...scope, source: { kind: 'commit', commit: 'HEAD' } })).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
    await writeFile(path, JSON.stringify({ ...stored, sessionId: 'another-session' }));
    await expect(readCapturedScmComparison(scope)).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
    await writeFile(path, JSON.stringify({ ...stored, comparison: { ...stored.comparison, endpoints: { before: 1 } } }));
    await expect(readCapturedScmComparison(scope)).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
    await writeFile(path, JSON.stringify(stored));
    await captureScmComparison({ cwd: fixture.rootPath, sessionId, source: { kind: 'workingTree' } });
    expect(await readFile(path, 'utf8')).not.toContain('"future"');
    await writeFile(path, JSON.stringify(stored));
    await deleteCapturedScmComparison(scope);
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
