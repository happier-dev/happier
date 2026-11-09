import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ScmChangeDiscardResponseSchema } from '@happier-dev/protocol/scm';
import { applyInverseEdits } from '@happier-dev/protocol/diff/hunks';
import { buildReviewUnits } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { FILE_REVIEW_NOTE_KIND, formatFileReviewNoteV1, type FileReviewNoteV1 } from '@happier-dev/protocol/messages/structured/fileReviewNoteV1';
import { buildCodexAppServerTurnInput } from '@happier-dev/plugins-codex/agent/runtime/appServer/turnInput';
import type { UserMessage } from '@/api/types';
import { createPermissionModeQueueState } from '@/agent/runtime/createPermissionModeQueueState';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { createRuntimeOverrideSynchronizers } from '@/agent/runtime/createRuntimeOverrideSynchronizers';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import { createSessionProviderInputOutcomeBinding, type SessionProviderInputOutcome } from '@/agent/runtime/session/input/providerInputOutcome';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createLocalScmRepositoryFixture, runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { createGitScmBackendRuntimeRegistration } from '../../../../../../packages/plugins/scm-git/src/backend';
import { createScmHostingProviderRuntimeServicesForTest } from '../../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import { captureScmComparison, deleteCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import { executeScmActionOperation } from '../executeScmActionOperation';
import { buildRepositoryCheckpointRefs } from '@/scm/checkpoints/refs';
import { gitCheckpointAdapter } from '@/scm/checkpoints/gitCheckpointAdapter';
import { retainRepositoryCheckpointTurnEvidence } from '@/scm/checkpoints/sessionEvidence';
import { createTestGitRpcManager } from '@/scm/rpc/__tests__/testRpcHarness';
import { prepareScmFileBytesExport, type ScmFileBytesExportInput } from '../deliverScmFileAtRevision';
import { WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES } from '@happier-dev/protocol/machines/workspaceFiles';
import { createDirectTransferServerLifecycle } from '@/machines/transfer/directTransferServerLifecycle';
import { commitGuardedFileReplace } from '@/rpc/handlers/fileSystem/commitGuardedFileReplace';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function captureTurn(rootPath: string, writeAfter: () => Promise<void>) {
  const sessionId = randomUUID();
  const turnId = 'turn-1';
  const scopeId = `${sessionId}:${rootPath}`;
  const refs = buildRepositoryCheckpointRefs({ scopeId, turnId });
  const context = { cwd: rootPath, projectKey: rootPath, detection: { isRepo: true, rootPath, mode: '.git' as const } };
  const before = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnStart! });
  if (!before.success) throw new Error('Turn start capture failed');
  await writeAfter();
  const after = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnFinal! });
  if (!after.success) throw new Error('Turn final capture failed');
  await retainRepositoryCheckpointTurnEvidence({ cwd: rootPath, scopeId, turnChangeSet: {
    sessionId, turnId, seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 }, status: 'completed',
    files: [], provider: 'agent', derivedAt: 1, repositoryCheckpoint: { version: 1, scopeId,
      startRef: refs.turnStart!.ref, finalRef: refs.turnFinal!.ref, baseRefSource: 'turn_start',
      contentConfidence: 'exact', attributionScope: 'shared_worktree', receipts: [...before.receipts, ...after.receipts] },
  } });
  const captured = await captureScmComparison({ cwd: rootPath, sessionId, source: { kind: 'turnCheckpoint', sessionId, turnId } });
  expect(captured.comparison.inventory.state).toBe('complete');
  return { ...captured, sessionId, turnId };
}

describe('comparison discard through the SCM Action executor', () => {
  const registration = createGitScmBackendRuntimeRegistration();
  const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
    definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.backend.git/git',
    executableDefinition: registration.runtime!, registration,
    hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(),
  })]);
  const roots: string[] = [];
  afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });

  it.each(['lf', 'crlf', 'bom', 'no-final-newline'] as const)('reverts one captured hunk and returns an exact guarded Undo (%s)', async mode => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-discard-comparison-' });
    roots.push(fixture.rootPath);
    const eol = mode === 'crlf' ? '\r\n' : '\n';
    let before = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join(eol) + (mode === 'no-final-newline' ? '' : eol);
    if (mode === 'bom') before = '\ufeff' + before;
    const file = join(fixture.rootPath, fixture.trackedPath);
    await writeFile(file, before);
    runScmExecutable(fixture.rootPath, 'git', ['add', fixture.trackedPath]);
    runScmExecutable(fixture.rootPath, 'git', ['commit', '-m', 'comparison base']);
    const after = before.replace('line 3', 'first change').replace('line 30', 'middle change').replace('line 58', 'last change');
    const captured = await captureTurn(fixture.rootPath, async () => { await writeFile(file, after); });
    const { call } = createTestGitRpcManager({ workingDirectory: fixture.rootPath });
    const authorization = { kind: 'session.write' as const, sessionId: captured.sessionId };
    try {
      const evidence = captured.comparison.inventory.files.find(value => value.path === fixture.trackedPath)!;
      expect(evidence.occurrences).toHaveLength(3);
      const input = { cwd: fixture.rootPath, outcomeVersion: 1, entries: [{ path: fixture.trackedPath, kind: 'comparison',
        against: { source: captured.comparison.source, comparisonId: captured.comparison.id },
        changeRefs: [evidence.occurrences[1]!.id], includeUndo: true, expectedHash: hash(Buffer.from(after)) }] };
      const result = ScmChangeDiscardResponseSchema.parse(await call('scm.change.discard', input, authorization));
      expect(result).toMatchObject({ success: true, entries: [{ status: 'reverted' }] });
      const reverted = after.replace('middle change', 'line 30');
      expect(await readFile(file, 'utf8')).toBe(reverted);
      const entry = result.entries![0]!;
      expect(entry.hashAfter).toBe(hash(Buffer.from(reverted)));
      expect(applyInverseEdits(reverted, entry.inverseEdits!)).toEqual({ ok: true, text: after });
      expect(JSON.stringify(entry.inverseEdits).length).toBeLessThan(after.length);
      await writeFile(file, 'concurrent writer\n');
      const refused = await call('scm.change.discard', input, authorization);
      expect(refused).toMatchObject({ success: false, errorCode: 'FILE_CHANGED' });
      expect(await readFile(file, 'utf8')).toBe('concurrent writer\n');
    } finally { await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId: captured.comparison.id, sessionId: captured.sessionId }); }
  });

  it('sends one next-turn review note through the real prompt loop, settles provider acceptance, and omits refused requests', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-discard-note-' });
    roots.push(fixture.rootPath);
    const file = join(fixture.rootPath, fixture.trackedPath);
    const before = Array.from({ length: 60 }, (_, index) => `line ${index + 1}\n`).join('');
    await writeFile(file, before);
    runScmExecutable(fixture.rootPath, 'git', ['add', fixture.trackedPath]);
    runScmExecutable(fixture.rootPath, 'git', ['commit', '-m', 'review note base']);
    const after = before.replace('line 3\n', 'first change\n').replace('line 58\n', 'last change\n');
    const captured = await captureTurn(fixture.rootPath, async () => { await writeFile(file, after); });
    onTestFinished(async () => { await deleteCapturedScmComparison({ cwd: fixture.rootPath,
      comparisonId: captured.comparison.id, sessionId: captured.sessionId }); });
    const evidence = captured.comparison.inventory.files.find(value => value.path === fixture.trackedPath)!;
    expect(evidence.occurrences).toHaveLength(2);
    const notes: (FileReviewNoteV1 & { sessionId: string })[] = [];
    let receive: ((message: UserMessage) => boolean | void) | undefined;
    const session = createMutableApiSessionClientFixture({ sessionId: captured.sessionId, overrides: {
      onUserMessage: handler => { receive = handler; },
    } });
    const state = createPermissionModeQueueState({ session,
      agentTargetKey: 'agent:happier.agent.codex/codex', initialPermissionMode: 'default' });
    onTestFinished(() => { state.messageQueue.close(); });
    const input = { cwd: fixture.rootPath, entries: [{ path: fixture.trackedPath, kind: 'comparison',
      against: { source: captured.comparison.source, comparisonId: captured.comparison.id },
      changeRefs: evidence.occurrences.map(occurrence => occurrence.id), expectedHash: hash(Buffer.from(after)), includeUndo: true }] };
    // These two ports are genuine Home authority and outward note-delivery boundaries.
    const params = { actionId: 'scm.change.discard' as const, input, registry, workingDirectory: fixture.rootPath,
      sessionId: captured.sessionId, authorizeSession: async (id: string | undefined) => id === captured.sessionId,
      emitFileReviewNote: async (note: FileReviewNoteV1 & { sessionId: string }) => {
        notes.push(note);
        if (!receive) throw new Error('Missing Session input binding');
        const { sessionId: _sessionId, ...payload } = note;
        receive({ role: 'user', localId: 'discard-note', content: { type: 'text', text: formatFileReviewNoteV1(payload) },
          inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine', nextTurnNote: FILE_REVIEW_NOTE_KIND },
          meta: { happier: { kind: FILE_REVIEW_NOTE_KIND, payload } } });
      } };
    const reverted = ScmChangeDiscardResponseSchema.parse(await executeScmActionOperation(params));
    expect(reverted).toMatchObject({ success: true });
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(applyInverseEdits(before, reverted.entries![0]!.inverseEdits!)).toEqual({ ok: true, text: after });
    expect(notes).toEqual([{ action: 'discard', sessionId: captured.sessionId, paths: [fixture.trackedPath], turnId: captured.turnId }]);
    expect(await executeScmActionOperation(params)).toMatchObject({ success: false, errorCode: 'FILE_CHANGED' });
    expect(notes).toHaveLength(1);
    // A successful real Discard is quiet until a real input arrives. Its note
    // must survive the production queue and prompt loop into Codex's codec.
    expect(state.messageQueue.size()).toBe(0);
    state.messageQueue.push({ text: 'Continue', localId: 'next-input' }, { permissionMode: 'default' });
    const nativeInputs: ReturnType<typeof buildCodexAppServerTurnInput>[] = [];
    const primaryInputIds: (readonly string[] | undefined)[] = [];
    const failures: unknown[] = [];
    const settlements: SessionProviderInputOutcome[] = [];
    const pendingLocalIds = new Set(['discard-note', 'next-input']);
    const binding = createSessionProviderInputOutcomeBinding({ getTarget: () => ({
      sessionId: session.sessionId, hasPendingProviderInput: localId => pendingLocalIds.has(localId),
      async observeProviderInputSettlement(outcome) {
        settlements.push(outcome);
        if (outcome.kind === 'accepted') pendingLocalIds.delete(outcome.localId);
        return true;
      },
    }) });
    onTestFinished(() => { binding.clearAcceptedEffects(); });
    // Only the external Agent process port is replaced. Queue admission, the
    // prompt loop, final context preparation and the native input codec are real.
    const runtime = {
      beginTurnLifecycle() {},
      async sendTurnPrompt(text, meta) {
        nativeInputs.push(buildCodexAppServerTurnInput({ text, structuredInput: meta?.structuredInput }));
        primaryInputIds.push(meta?.localIds);
        if (!meta?.localId) throw new Error('Missing native primary input identity');
        binding.observeProviderInputOutcome({ type: 'input-accepted', localInputId: meta.localId,
          userMessageSeq: meta.userMessageSeq ?? null, userMessageSeqs: meta.userMessageSeqs,
          delivery: { kind: 'newTurn', turnId: 'native-review-turn' } });
      },
      async waitForTurnCompletion() {},
      subscribeRuntimeEvents: () => () => {},
      async cancelTurn() {},
      readSessionIdentity: () => ({ sessionId: 'native-review-thread' }),
      async updateSessionRuntimeConfig() {},
      async resetOrDisposeRuntime() {},
    } satisfies RuntimeTurnOperations;
    const lifetime = new AbortController();
    onTestFinished(() => { lifetime.abort(); });
    const permissionHandler = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[FileReviewNotes]' });
    let finished = false;
    await runPermissionModePromptLoop({
      providerName: 'Codex', agentMessageType: 'codex', explicitPermissionMode: undefined,
      session, messageQueue: state.messageQueue, runtime,
      permissionHandler,
      createOverrideSynchronizer: (isStarted) => createRuntimeOverrideSynchronizers({
        agentTargetKey: 'agent:happier.agent.codex/codex', session, isStarted,
        runtime: { async setSessionMode() {}, async setSessionModelSelection() {}, async setSessionConfigOption() {} },
      }),
      messageBuffer: new MessageBuffer(), shouldExit: () => finished,
      getAbortSignal: () => lifetime.signal, keepAlive() {}, setThinking() {},
      sendReady: () => { finished = true; },
      currentPermissionModeUpdatedAt: state.getCurrentPermissionModeUpdatedAt(),
      setCurrentPermissionMode: state.setCurrentPermissionMode,
      setCurrentPermissionModeUpdatedAt: state.setCurrentPermissionModeUpdatedAt,
      registerProviderAcceptedEffect: binding.registerProviderAcceptedEffect, formatPromptErrorMessage: String,
      onPromptFailure: error => { failures.push(error); },
    });
    expect(failures).toEqual([]);
    expect(nativeInputs).toEqual([[{ type: 'text', text: `Continue\n\n<happier_review_note>${JSON.stringify({
      text: `The person reviewing your work discarded your changes in ${JSON.stringify(fixture.trackedPath)} (turn "turn-1"). Do not reapply them unless asked.`,
    })}</happier_review_note>` }]]);
    expect(primaryInputIds).toEqual([['next-input']]);
    await vi.waitFor(() => expect(settlements.filter(outcome => outcome.kind === 'accepted')
      .map(outcome => outcome.localId).sort()).toEqual(['discard-note', 'next-input']));
    expect(state.messageQueue.getContextOnlyMessages()).toEqual([]);
  });

  it('omits a run count for one captured Git hunk containing two review runs', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-discard-ref-note-' });
    roots.push(fixture.rootPath);
    const file = join(fixture.rootPath, fixture.trackedPath);
    const before = Array.from({ length: 15 }, (_, index) => `line ${index + 1}\n`).join('');
    await writeFile(file, before);
    runScmExecutable(fixture.rootPath, 'git', ['add', fixture.trackedPath]);
    runScmExecutable(fixture.rootPath, 'git', ['commit', '-m', 'ref note base']);
    const after = before.replace('line 3\n', 'first change\n').replace('line 7\n', 'second change\n');
    const captured = await captureTurn(fixture.rootPath, async () => { await writeFile(file, after); });
    try {
      const evidence = captured.comparison.inventory.files.find(value => value.path === fixture.trackedPath)!;
      expect(evidence.occurrences).toHaveLength(1);
      expect(buildReviewUnits(evidence.path, 'combined', evidence.evidence.unifiedDiff!)).toHaveLength(2);
      const notes: (FileReviewNoteV1 & { sessionId: string })[] = [];
      const response = await executeScmActionOperation({ actionId: 'scm.change.discard', registry, workingDirectory: fixture.rootPath,
        sessionId: captured.sessionId, authorizeSession: async id => id === captured.sessionId,
        emitFileReviewNote: async note => { notes.push(note); },
        input: { cwd: fixture.rootPath, entries: [{ path: fixture.trackedPath, kind: 'comparison',
          against: { source: captured.comparison.source, comparisonId: captured.comparison.id }, changeRefs: [evidence.occurrences[0]!.id] }] },
      });
      expect(response).toMatchObject({ success: true });
      expect(await readFile(file, 'utf8')).toBe(before);
      expect(notes).toEqual([{ action: 'discard', sessionId: captured.sessionId, paths: [fixture.trackedPath], turnId: captured.turnId }]);
    } finally { await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId: captured.comparison.id, sessionId: captured.sessionId }); }
  });

  it('refuses staged selections and invalid UTF-8 without changing bytes or the index', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-discard-refusal-' });
    roots.push(fixture.rootPath);
    const file = join(fixture.rootPath, fixture.trackedPath);
    const before = await readFile(file, 'utf8');
    const after = `${before}selected change\n`;
    const captured = await captureTurn(fixture.rootPath, async () => { await writeFile(file, after); });
    const evidence = captured.comparison.inventory.files.find(value => value.path === fixture.trackedPath)!;
    const entry = { path: fixture.trackedPath, kind: 'comparison', against: {
      source: captured.comparison.source, comparisonId: captured.comparison.id }, changeRefs: [evidence.occurrences[0]!.id], includeUndo: true };
    try {
      const invalid = Buffer.from([255, 254, 0]);
      await writeFile(file, invalid);
      expect(await executeScmActionOperation({ actionId: 'scm.change.discard', registry, workingDirectory: fixture.rootPath,
        sessionId: captured.sessionId, authorizeSession: async () => true, input: { cwd: fixture.rootPath, entries: [entry] } }))
        .toMatchObject({ success: false, errorCode: 'DISCARD_UNSUPPORTED' });
      expect(await readFile(file)).toEqual(invalid);
      await writeFile(file, after);
      runScmExecutable(fixture.rootPath, 'git', ['add', fixture.trackedPath]);
      const index = runScmExecutable(fixture.rootPath, 'git', ['write-tree']);
      const diff = runScmExecutable(fixture.rootPath, 'git', ['diff', '--cached', '--no-color', '-U3', '--', fixture.trackedPath]);
      const keys = buildReviewUnits(fixture.trackedPath, 'combined', diff).map(unit => unit.key);
      expect(await executeScmActionOperation({ actionId: 'scm.change.discard', registry, workingDirectory: fixture.rootPath,
        input: { cwd: fixture.rootPath, entries: [{ path: fixture.trackedPath, kind: 'comparison', against: { source: { kind: 'workingTree' } }, changeKeys: keys }] } }))
        .toMatchObject({ success: false, errorCode: 'DISCARD_UNSUPPORTED' });
      expect(await readFile(file, 'utf8')).toBe(after);
      expect(runScmExecutable(fixture.rootPath, 'git', ['write-tree'])).toBe(index);
    } finally { await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId: captured.comparison.id, sessionId: captured.sessionId }); }
  });

  it('keeps a small unit inverse small in a multi-megabyte file', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-discard-large-context-' });
    roots.push(fixture.rootPath);
    const file = join(fixture.rootPath, fixture.trackedPath);
    const before = `${'unchanged context\n'.repeat(200_000)}original tail\n`;
    await writeFile(file, before);
    runScmExecutable(fixture.rootPath, 'git', ['add', fixture.trackedPath]);
    runScmExecutable(fixture.rootPath, 'git', ['commit', '-m', 'large context base']);
    await writeFile(file, before.replace('original tail', 'changed tail'));
    const diff = runScmExecutable(fixture.rootPath, 'git', ['diff', '--no-color', '-U3', 'HEAD', '--', fixture.trackedPath]);
    const keys = buildReviewUnits(fixture.trackedPath, 'combined', diff).map(unit => unit.key);
    const result = ScmChangeDiscardResponseSchema.parse(await executeScmActionOperation({ actionId: 'scm.change.discard', registry,
      workingDirectory: fixture.rootPath, input: { cwd: fixture.rootPath, entries: [{ path: fixture.trackedPath, kind: 'comparison',
        against: { source: { kind: 'workingTree' } }, changeKeys: keys, includeUndo: true }] } }));
    expect(result.success).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(Buffer.byteLength(JSON.stringify(result.entries![0]!.inverseEdits))).toBeLessThan(512);
  });

  it('restores binary bytes, deletes only an untouched added file, recreates a deleted file, and enforces retained Session authority through encrypted RPC', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-discard-file-states-' });
    roots.push(fixture.rootPath);
    const binary = Buffer.from([0, 255, 128, 13, 10]);
    await writeFile(join(fixture.rootPath, 'image.bin'), binary);
    await writeFile(join(fixture.rootPath, 'deleted.txt'), 'before deletion\n');
    runScmExecutable(fixture.rootPath, 'git', ['add', '.']);
    runScmExecutable(fixture.rootPath, 'git', ['commit', '-m', 'file state base']);
    const captured = await captureTurn(fixture.rootPath, async () => {
      await writeFile(join(fixture.rootPath, 'image.bin'), Buffer.from([0, 254, 129]));
      await writeFile(join(fixture.rootPath, 'added.txt'), 'added by turn\n');
      await rm(join(fixture.rootPath, 'deleted.txt'));
    });
    const { call } = createTestGitRpcManager({ workingDirectory: fixture.rootPath });
    const request = (path: string) => ({ cwd: fixture.rootPath, outcomeVersion: 1, entries: [{ path, kind: 'comparison',
      against: { source: captured.comparison.source, comparisonId: captured.comparison.id }, includeUndo: true }] });
    const authorization = { kind: 'session.write' as const, sessionId: captured.sessionId };
    const indexBefore = runScmExecutable(fixture.rootPath, 'git', ['write-tree']);
    try {
      for (const scope of [undefined, { kind: 'session.write' as const, sessionId: 'different-session' }]) {
        expect(await call('scm.change.discard', request('image.bin'), scope)).toMatchObject({ success: false, errorCode: 'COMPARISON_UNAVAILABLE' });
      }
      const previous = Buffer.from([0, 253, 130, 10]);
      await writeFile(join(fixture.rootPath, 'image.bin'), previous);
      expect(await call('scm.change.discard', request('image.bin'), authorization)).toMatchObject({ success: true, entries: [{ status: 'restored',
        previous: { inlineBase64: previous.toString('base64') } }] });
      expect(await readFile(join(fixture.rootPath, 'image.bin'))).toEqual(binary);
      await writeFile(join(fixture.rootPath, 'added.txt'), 'edited after the turn\n');
      expect(await call('scm.change.discard', request('added.txt'), authorization)).toMatchObject({ success: true, entries: [{ status: 'kept_edited' }] });
      expect(await readFile(join(fixture.rootPath, 'added.txt'), 'utf8')).toBe('edited after the turn\n');
      await writeFile(join(fixture.rootPath, 'added.txt'), 'added by turn\n');
      expect(await call('scm.change.discard', request('added.txt'), authorization)).toMatchObject({ success: true, entries: [{ status: 'deleted', hashAfter: null,
        previous: { inlineBase64: Buffer.from('added by turn\n').toString('base64') } }] });
      await expect(stat(join(fixture.rootPath, 'added.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      const recreated = ScmChangeDiscardResponseSchema.parse(await call('scm.change.discard', request('deleted.txt'), authorization));
      expect(recreated).toMatchObject({ success: true, entries: [{ status: 'recreated', hashBefore: null }] });
      expect(recreated.entries![0]).not.toHaveProperty('previous');
      expect(recreated.entries![0]).not.toHaveProperty('inverseEdits');
      expect(await readFile(join(fixture.rootPath, 'deleted.txt'), 'utf8')).toBe('before deletion\n');
      expect(runScmExecutable(fixture.rootPath, 'git', ['write-tree'])).toBe(indexBefore);
    } finally { await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId: captured.comparison.id, sessionId: captured.sessionId }); }
  });

  it('exports previous bytes using the aggregate response budget before mutating any file', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-discard-aggregate-undo-' });
    roots.push(fixture.rootPath);
    const paths = ['first.bin', 'second.bin'];
    for (const path of paths) await writeFile(join(fixture.rootPath, path), Buffer.from([0, 1, 2]));
    runScmExecutable(fixture.rootPath, 'git', ['add', '.']);
    runScmExecutable(fixture.rootPath, 'git', ['commit', '-m', 'aggregate restore base']);
    // Each pre-image's base64 takes exactly half the raw response budget; its envelope pushes their aggregate over.
    const previous = Buffer.alloc(Math.floor(WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES * 3 / 8), 255);
    for (const path of paths) await writeFile(join(fixture.rootPath, path), previous);
    const disposers: (() => void | Promise<void>)[] = [];
    let published = false;
    try {
      const result = ScmChangeDiscardResponseSchema.parse(await executeScmActionOperation({ actionId: 'scm.change.discard', registry,
        workingDirectory: fixture.rootPath,
        input: { cwd: fixture.rootPath, entries: paths.map(path => ({ path, kind: 'comparison',
          against: { source: { kind: 'workingTree' } }, includeUndo: true })) },
        prepareFileBytesExport: async input => await prepareScmFileBytesExport({ ...input, lifecycle: {
          clearPublishedTransfer: () => true,
          publishTransferWhenReady: async input => {
            // Publication is an external capability boundary. All file reads/writes and payload preparation stay real.
            for (const path of paths) expect((await readFile(join(fixture.rootPath, path))).equals(previous)).toBe(true);
            const source = input.payloadSource;
            if (!source || source.kind !== 'file') throw new Error('Prepared export must use its owned byte source');
            expect((await readFile(source.filePath)).equals(previous)).toBe(true);
            if (source.dispose) disposers.push(source.dispose);
            published = true;
            return { transferId: input.transferId, transferToken: 'test-capability', endpointCandidates: [], expiresAt: Date.now() + 60_000 };
          },
        } }),
      }));
      expect({ success: result.success, errorCode: result.errorCode, error: result.error }).toMatchObject({ success: true });
      expect(published).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES);
      expect(result.entries?.some(entry => entry.previous && 'export' in entry.previous)).toBe(true);
      for (const path of paths) expect(await readFile(join(fixture.rootPath, path))).toEqual(Buffer.from([0, 1, 2]));
    } finally {
      await Promise.all(disposers.map(dispose => dispose()));
    }
  });

  it.each(['available', 'unavailable'] as const)('exports oversized unit Undo before mutation and roundtrips exact bytes (%s publisher)', async publisher => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-discard-large-unit-' });
    roots.push(fixture.rootPath);
    const file = join(fixture.rootPath, fixture.trackedPath);
    // Each JSON-escaped control character uses six bytes in either side of
    // the inverse, while the real Git diff retains its one-byte text form.
    // This crosses the reply boundary without bypassing Git's output budget.
    const spanLength = Math.floor(WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES / 12) + 1;
    const before = `${'\u0001'.repeat(spanLength)}\n`;
    const after = `${'\u0002'.repeat(spanLength)}\n`;
    await writeFile(file, before);
    runScmExecutable(fixture.rootPath, 'git', ['add', fixture.trackedPath]);
    runScmExecutable(fixture.rootPath, 'git', ['commit', '-m', 'large unit base']);
    await writeFile(file, after);
    const selection = await registry.selectBackend({ cwd: fixture.rootPath, workingDirectory: fixture.rootPath });
    if (!selection?.backend.diffFile) throw new Error('The real Git diff owner is unavailable');
    const diff = await selection.backend.diffFile({
      context: { cwd: fixture.rootPath, projectKey: fixture.rootPath, detection: selection.detection },
      request: { cwd: fixture.rootPath, path: fixture.trackedPath, area: 'both' },
    });
    expect({ success: diff.success, errorCode: diff.errorCode, error: diff.error }).toMatchObject({ success: true });
    if (!diff.success || diff.diff === undefined) throw new Error('Expected an admitted real Git diff');
    const keys = buildReviewUnits(fixture.trackedPath, 'combined', diff.diff).map(unit => unit.key);
    expect(keys.length).toBeGreaterThan(0);
    const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
    try {
    const response = ScmChangeDiscardResponseSchema.parse(await executeScmActionOperation({ actionId: 'scm.change.discard', registry,
      workingDirectory: fixture.rootPath, sessionId: 'review-session', authorizeSession: async () => true,
      ...(publisher === 'available' ? { prepareFileBytesExport: async (input: ScmFileBytesExportInput) => {
        expect(await readFile(file, 'utf8')).toBe(after);
        return await prepareScmFileBytesExport({ ...input, lifecycle });
      } } : {}),
      input: { cwd: fixture.rootPath, entries: [{ path: fixture.trackedPath, kind: 'comparison',
        against: { source: { kind: 'workingTree' } }, changeKeys: keys, includeUndo: true }] } }));
    if (publisher === 'unavailable') {
      expect(response).toMatchObject({ success: false, errorCode: 'COMPARISON_UNAVAILABLE', error: 'Prepared Undo delivery is unavailable' });
      expect((await readFile(file)).equals(Buffer.from(after))).toBe(true);
      return;
    }
    expect({ success: response.success, errorCode: response.errorCode, error: response.error }).toMatchObject({ success: true });
    expect((await readFile(file)).equals(Buffer.from(before))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES);
    const entry = response.entries![0]!;
    expect(entry.inverseEdits).toBeUndefined();
    if (!entry.previous || !('export' in entry.previous)) throw new Error('Oversized inverse must use its exact preimage export');
    const prepared = entry.previous.export;
    const downloaded = await lifecycle.requestPayloadFile({ transferId: prepared.transferId, endpointCandidates: prepared.endpointCandidates,
      destinationPath: join(fixture.rootPath, 'downloaded-undo'), expectedSizeBytes: prepared.sizeBytes, expectedManifestHash: prepared.manifestHash,
      // Adapt only HTTP transport into the existing prepared-RPC boundary. The
      // capability, encryption, manifest and actual export byte reader stay real.
      fetchFn: async (input, init) => {
        const endpoint = prepared.endpointCandidates[0];
        if (!endpoint?.authorizationToken) throw new Error('Prepared transfer authority is unavailable');
        const response = await lifecycle.requestPreparedTransfer({ t: 'prepared_machine_transfer_v1',
          authorizationToken: endpoint.authorizationToken,
          recipientPublicKeyBase64: new Headers(init?.headers).get('x-happier-transfer-recipient-public-key')!,
          path: new URL(String(input)).pathname, httpMethod: init?.method === 'GET' ? 'GET' : 'POST',
          ...(typeof init?.body === 'string' ? { body: StrictJsonValueSchema.parse(JSON.parse(init.body)) } : {}) });
        return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json' } });
      } });
    const bytes = await readFile(downloaded.destinationPath);
    expect(bytes).toEqual(Buffer.from(after));
    expect(await commitGuardedFileReplace({ destPath: file, expectation: entry.hashAfter, source: { kind: 'bytes', bytes } }))
      .toMatchObject({ success: true, hash: hash(Buffer.from(after)) });
    expect(await readFile(file, 'utf8')).toBe(after);
    } finally { await lifecycle.stop(); }
  });
});
