import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { createEncryptedTransferChunkEnvelope } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';
import { createTransferManifestHasher } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferManifestHasher';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import type { ScmWorkingEntry } from '@happier-dev/protocol/scm';
import { applyInverseEdits } from '@happier-dev/protocol/diff/hunks';
import { WorkspaceFilesReplaceActionInputSchema, WorkspaceFilesReplaceActionOutputSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { decideApprovalAsInbox, installOwnMachineApprovalReplayBoundary } from '@/dev/testkit/harness/approvalInbox';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const rpc = vi.hoisted(() => ({ responses: [] as unknown[], requests: [] as unknown[] }));
const transfer = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));
vi.mock('@/utils/system/runtimeFetch', async importOriginal => {
  const actual = await importOriginal<typeof import('@/utils/system/runtimeFetch')>();
  // Named first so the getter's `this` is this object, not vi.mock's Partial<unknown> factory type; the getter's
  // return type is explicit because it reads its own object (TS7023 otherwise).
  const mocked = { ...actual, runtimeFetch: (...args: Parameters<typeof fetch>) => String(args[0]).includes('/machine-transfers/direct/')
    ? transfer.fetch(...args) : actual.runtimeFetch(...args) ,
      get runtimeFetchManualResponse(): (...args: Parameters<typeof fetch>) => Promise<Response> { return this.runtimeFetch; },
  };
  return mocked;
});
// Keep Action approval, output validation, restore dispatch and notices real.
// The remote Machine RPC is the genuine network boundary.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: async (request: unknown) => {
    rpc.requests.push(request);
    if (request && typeof request === 'object' && 'method' in request && request.method === 'daemon.directTransfer.export.release') return { success: true };
    const response = rpc.responses.shift();
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response(request) : response;
  },
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
const { discardChange } = await import('./discardChange');
const { useHunkDiscard } = await import('@/components/workspaces/scm/review/hunkReview/useHunkDiscard');
const { useFileChangesReview } = await import('@/components/workspaces/files/file/changes/useFileChangesReview');
const { useAskSelectionTargetContext } = await import('@/components/ui/code/selection/useAskSelection');
const { readPresentationNotice, retirePresentationNotice, publishPresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
const { PresentationNoticeHost } = await import('@/components/sessions/presentation/PresentationNoticeHost');

const messages = { discarded: 'discarded', restored: 'restored', kept_edited: 'kept', undone: 'undone', undo_conflict: 'undo conflict',
  undo: 'undo', moved_on: 'moved on', update_required: 'update required', unsupported: 'unsupported', unavailable: 'unavailable', unknown: 'unknown', note_failed: 'file changed; note delivery failed', undo_unavailable: 'file changed; Undo unavailable' };
const beforeHash = 'a'.repeat(64);
const afterHash = 'b'.repeat(64);

describe('comparison Discard and guarded Undo', () => {
  let serverId: string;
  beforeEach(async () => {
    rpc.requests.length = 0; rpc.responses.length = 0;
    transfer.fetch.mockReset(); transfer.fetch.mockRejectedValue(new Error('Unexpected transfer request'));
    retirePresentationNotice();
    await homes.reset(); await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Review Home', serverUrl: 'https://discard-review.test', serverIdentityId: 'srv_discard_review', accountId: 'review-account', currentAccount: true });
    const sessions = V2SessionListResponseSchema.parse({ sessions: [], hasNext: false, nextCursor: null });
    homes.answer(serverId, '/v2/sessions', { body: sessions });
    homes.answer(serverId, '/v2/sessions/active', { body: sessions });
    for (const actionId of ['daemon.filesystem.writeFile', 'daemon.filesystem.readFile', 'workspace.files.replace'] as const) {
      const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://discard-review.test',
        serverIdentityId: 'srv_discard_review', accountId: 'review-account', machineId: 'm1',
        actionId, tokenEpoch: 0,
        execute: (input, context) => {
          expect(context.invocation).toMatchObject({ surface: 'ui', authority: 'present_user', caller: { kind: 'host' } });
          rpc.requests.push({ payload: input });
          const response = rpc.responses.shift();
          if (response instanceof Error) throw response;
          return typeof response === 'function' ? response(input, context.requestId) : response;
        },
      });
      homes.answer(serverId, '/v1/machines', { body: [boundary.machine] });
      homes.answer(serverId, 'GET /v1/machines/m1', { body: { machine: boundary.machine } });
      for (const path of [`/v1/actions/${actionId}/execution-authorization`, `/v1/actions/${actionId}`]) {
        homes.answer(serverId, path, { select: async (_input, request) => {
          const response = await boundary.handle(new URL(request.url), request.init);
          if (!response) throw new Error(`Unhandled Undo HTTP boundary: ${request.url}`);
          return { status: response.status, body: await response.json() };
        } });
      }
    }
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://discard-review.test')!.token! });
  });
  afterEach(async () => {
    retirePresentationNotice(); await standardCleanup();
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection(); await homes.reset();
  });
  const input = () => ({ target: { machineId: 'm1', rootPath: '/repo', serverId },
    entry: { kind: 'comparison' as const, path: 'a.txt', against: { source: { kind: 'workingTree' as const } }, changeKeys: ['key'], expectedHash: beforeHash },
    messages, refresh: async () => {} });

  it('addresses a machine-routed Discard to the same session as its Undo note', async () => {
    rpc.responses.push({ success: true, noteDelivery: { status: 'queued' }, entries: [{
      path: 'a.txt', status: 'reverted', hashBefore: beforeHash, hashAfter: afterHash,
    }] });
    const result = await discardChange({ ...input(), sessionTarget: { sessionId: 'review-session', serverId } });
    expect(result).toMatchObject({ ok: true, noteDelivery: 'queued' });
    expect(rpc.requests).toEqual(expect.arrayContaining([expect.objectContaining({
      authorization: { kind: 'session.write', sessionId: 'review-session' },
      payload: expect.objectContaining({ entries: [expect.objectContaining({
        against: { source: { kind: 'workingTree' } },
      })] }),
    })]));
  });

  it('carries the retained turn session through Action admission to authenticated machine ingress', async () => {
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'reverted', hashBefore: beforeHash, hashAfter: afterHash }] });
    const params = input();
    const result = await discardChange({ ...params, entry: { ...params.entry,
      against: { source: { kind: 'turnCheckpoint', sessionId: 'review-session', turnId: 'turn-1' }, comparisonId: 'c'.repeat(64), sessionId: 'review-session' },
    }, sessionTarget: { sessionId: 'review-session', serverId } });
    expect(result.ok).toBe(true);
    expect(rpc.requests).toEqual(expect.arrayContaining([expect.objectContaining({
      authorization: { kind: 'session.write', sessionId: 'review-session' },
      payload: expect.objectContaining({ entries: [expect.objectContaining({
        against: expect.objectContaining({ comparisonId: 'c'.repeat(64), sessionId: 'review-session' }),
      })] }),
    })]));
  });

  it('uses a captured repository root for Restore and its guarded Undo from a nested Session cwd', async () => {
    const { useFileChangesActions } = await import('@/components/workspaces/files/file/changes/useFileChangesActions');
    const { ScmComparisonSchema } = await import('@happier-dev/protocol/scm');
    const params = input();
    const comparison = ScmComparisonSchema.parse({ id: 'c'.repeat(64),
      source: { kind: 'turnCheckpoint', turnId: 'turn-1' }, repository: { rootPath: '/repo' },
      endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } });
    const hook = await renderHook(() => useFileChangesActions({ ...params,
      target: { ...params.target, rootPath: '/repo/nested' }, filePath: 'nested/a.txt',
      selector: { kind: 'turnCheckpoint', turnId: 'turn-1' }, comparison, changed: true,
      hasUnsavedEdits: () => false, onReplacedUnsavedEdits: () => {}, confirmUnsaved: { title: 'Replace' },
    }));
    rpc.responses.push({ success: true, entries: [{ path: 'nested/a.txt', status: 'restored',
      hashBefore: beforeHash, hashAfter: afterHash, previous: { inlineBase64: '77u/bmV3DQo=' } }] },
      { success: true, hash: beforeHash });
    await act(async () => { await hook.getCurrent().changes.restoreBeforeTurn!(); });
    const result = hook.getCurrent().result;
    if (!result?.ok || !result.undo) throw new Error('Restore must retain Undo');
    expect(await result.undo()).toEqual({ success: true });
    expect(rpc.requests).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({
      path: '/repo/nested/a.txt', expectedHash: afterHash, content: '77u/bmV3DQo=',
    }) })]));
  });

  it('refuses managed hunk Discard without touching the controller repository at the same path', async () => {
    const { buildReviewUnits } = await import('@happier-dev/protocol/scm/comparisonOccurrences');
    const { t } = await import('@/text');
    const workspace = { v: 2, kind: 'managed', serverId, workspaceId: 'managed-project', managedId: 'guest',
      controller: { machineId: 'm1', installationId: 'install' }, rootPath: '/repo' } as const;
    const hook = await renderHook(() => useHunkDiscard({
      scope: { machineId: 'm1', serverId, rootPath: '/repo', workspace },
      sessionId: null, machineName: 'Machine', unreachable: false, refresh: () => {},
    }));
    let controllerText = 'new';
    rpc.responses.push(() => {
      controllerText = 'old';
      return { success: true, entries: [{ path: 'a.txt', status: 'reverted', hashBefore: beforeHash, hashAfter: afterHash }] };
    });
    const unit = buildReviewUnits('a.txt', 'combined', '@@ -1 +1 @@\n-old\n+new\n')[0]!;
    await act(async () => {
      await hook.getCurrent().discard({ path: 'a.txt', changeKey: unit.key,
        source: { kind: 'live', root: '/repo' }, unit });
    });
    expect(controllerText).toBe('new');
    expect(rpc.requests).toHaveLength(0);
    expect(hook.getCurrent().discardDisabledReason).toBe(t('hunkReview.noticeUnsupported'));
    expect(readPresentationNotice()).toMatchObject({ message: t('hunkReview.noticeUnsupported'), severity: 'error' });
  });

  it('undoes a captured selected hunk through restore at the repository root from a nested Session cwd', async () => {
    const { ScmComparisonSchema } = await import('@happier-dev/protocol/scm');
    const { buildReviewUnits } = await import('@happier-dev/protocol/scm/comparisonOccurrences');
    const comparison = ScmComparisonSchema.parse({ id: 'c'.repeat(64),
      source: { kind: 'turnCheckpoint', turnId: 'turn-1' }, repository: { rootPath: '/repo' },
      endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } });
    const unit = buildReviewUnits('nested/a.txt', 'combined', '@@ -1 +1 @@\n-old\n+new\n')[0]!;
    const hook = await renderHook(() => useHunkDiscard({ scope: { machineId: 'm1', serverId, rootPath: '/repo/nested' },
      sessionId: null, machineName: 'Machine', unreachable: false, refresh: () => {} }));
    rpc.responses.push({ success: true, entries: [{ path: 'nested/a.txt', status: 'reverted', hashBefore: beforeHash, hashAfter: afterHash,
      inverseEdits: [{ startUtf16: 1, deleteLength: 3, insertText: 'old', originalText: 'new' }] }] },
      { ok: true, results: [{ path: 'nested/a.txt', status: 'restored', hash: beforeHash }] });
    await act(async () => { await hook.getCurrent().discard({ path: 'nested/a.txt', changeKey: unit.key,
      source: { kind: 'captured', comparison }, unit }); });
    const undo = readPresentationNotice()?.undo;
    if (!undo) throw new Error('Selected Discard must retain Undo');
    expect(await undo.run()).toEqual({ success: true });
    expect(rpc.requests).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({
      rootPath: '/repo', operation: { kind: 'restore', files: [{ path: 'nested/a.txt', expectedHash: afterHash,
        edits: [{ startUtf16: 1, deleteLength: 3, insertText: 'old', originalText: 'new' }] }] },
    }) })]));
    expect(rpc.responses).toHaveLength(0);
  });

  it('publishes sticky Undo through the agent restore operation guarded by the post-discard hash', async () => {
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'reverted', hashBefore: beforeHash, hashAfter: afterHash,
      inverseEdits: [{ startUtf16: 1, deleteLength: 3, insertText: 'old', originalText: 'new' }] }] },
      { ok: true, results: [{ path: 'a.txt', status: 'restored', hash: beforeHash }] });
    const result = await discardChange(input());
    expect(result.ok).toBe(true);
    expect(readPresentationNotice()).toMatchObject({ sticky: true, message: 'discarded', undo: { label: 'undo' } });
    if (!result.ok || !result.undo) throw new Error('Undo must be available');
    expect(await Promise.all([result.undo(), result.undo()])).toEqual([{ success: true }, { success: true }]);
    expect(rpc.requests).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({
      rootPath: '/repo', operation: { kind: 'restore', files: [{ path: 'a.txt', expectedHash: afterHash,
        edits: [{ startUtf16: 1, deleteLength: 3, insertText: 'old', originalText: 'new' }] }] },
    }) })]));
    expect(readPresentationNotice()).toMatchObject({ message: 'undone' });
    expect(rpc.responses).toHaveLength(0);
  });

  it('confirms exact selected-hunk Undo bytes from the admitted operation receipt without a file read', async () => {
    const original = '\uFEFFconst message = "Welcome";\r\nconst punctuation = "!";\r\n';
    const discarded = original.replace('Welcome', 'Hello');
    let disk = original;
    let requestId: string | undefined;
    const edits = [{ startUtf16: original.indexOf('Welcome'), deleteLength: 'Welcome'.length,
      insertText: 'Hello', originalText: 'Welcome' }];
    rpc.responses.push(() => {
      disk = discarded;
      return { success: true, entries: [{ path: 'a.txt', status: 'reverted', hashBefore: beforeHash,
        hashAfter: afterHash, inverseEdits: edits }] };
    }, (input: unknown, admittedRequestId?: string) => {
      const request = WorkspaceFilesReplaceActionInputSchema.parse(input);
      if (request.operation.kind !== 'restore') throw new Error('Undo must use the restore owner');
      expect(request.operation.files[0]?.expectedHash).toBe(afterHash);
      const restored = applyInverseEdits(disk, request.operation.files[0]!.edits);
      if (!restored.ok) throw new Error('Undo did not restore the selected change');
      disk = restored.text;
      requestId = admittedRequestId;
      return { operation: { operationId: 'undo-operation' } };
    }, () => ({ kind: 'found', operation: ActionOperationSnapshotV1Schema.parse({
      version: 1, operationId: 'undo-operation', revision: 3, actionId: 'workspace.files.replace',
      state: 'succeeded', scope: { accountId: 'review-account', machineId: 'm1' }, requestId,
      title: 'Undo', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported',
      result: { ok: true, results: [{ path: 'a.txt', status: 'restored', hash: beforeHash }] },
    }) }));
    const result = await discardChange(input());
    expect(disk).toBe(discarded);
    if (!result.ok || !result.undo) throw new Error('Undo must be available');
    expect(await result.undo()).toEqual({ success: true });
    expect(new TextEncoder().encode(disk)).toEqual(new TextEncoder().encode(original));
    expect(readPresentationNotice()).toMatchObject({ message: messages.undone });
    expect(rpc.requests).toHaveLength(3);
    expect(rpc.responses).toHaveLength(0);
  });

  it('keeps selected-hunk Undo pending for approval and confirms exact bytes after approval', async () => {
    await homes.requireUiApproval(serverId, 'workspace.files.replace');
    await installOwnMachineApprovalReplayBoundary({ harness: homes, serverId, accountId: 'review-account', machineId: 'm1',
      machineFilesystemEffects: { workspaceFilesReplace: async (input, context) => {
        const response = rpc.responses.shift();
        if (typeof response !== 'function') throw new Error('Unexpected approved restore');
        return WorkspaceFilesReplaceActionOutputSchema.parse(response(input, context.actionRequestId));
      } } });
    const screen = await renderScreen(React.createElement(PresentationNoticeHost));
    const original = '\uFEFFWelcome\r\nunchanged!\r\n';
    let disk = original;
    let requestId: string | undefined;
    const edits = [{ startUtf16: 1, deleteLength: 7, insertText: 'Hello', originalText: 'Welcome' }];
    rpc.responses.push(() => {
      disk = original.replace('Welcome', 'Hello');
      return { success: true, entries: [{ path: 'a.txt', status: 'reverted', hashBefore: beforeHash,
        hashAfter: afterHash, inverseEdits: edits }] };
    }, (input: unknown, admittedRequestId?: string) => {
      const request = WorkspaceFilesReplaceActionInputSchema.parse(input);
      if (request.operation.kind !== 'restore') throw new Error('Undo must use restore');
      expect(request.operation.files[0]?.expectedHash).toBe(afterHash);
      const restored = applyInverseEdits(disk, request.operation.files[0]!.edits);
      if (!restored.ok) throw new Error('Undo did not restore the selected change');
      disk = restored.text;
      requestId = admittedRequestId;
      return { operation: { operationId: 'approved-undo-operation' } };
    }, () => ({ kind: 'found', operation: ActionOperationSnapshotV1Schema.parse({
      version: 1, operationId: 'approved-undo-operation', revision: 3, actionId: 'workspace.files.replace',
      state: 'succeeded', scope: { accountId: 'review-account', machineId: 'm1' }, requestId,
      title: 'Undo', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported',
      result: { ok: true, results: [{ path: 'a.txt', status: 'restored', hash: beforeHash }] },
    }) }));
    const { buildReviewUnits } = await import('@happier-dev/protocol/scm/comparisonOccurrences');
    const { t } = await import('@/text');
    const unit = buildReviewUnits('a.txt', 'combined', '@@ -1 +1 @@\n-Hello\n+Welcome\n')[0]!;
    const hook = await renderHook(() => useHunkDiscard({ scope: { machineId: 'm1', serverId, rootPath: '/repo' },
      sessionId: null, machineName: 'Machine', unreachable: false, refresh: () => {} }));
    await act(async () => { await hook.getCurrent().discard({ path: 'a.txt', changeKey: unit.key,
      source: { kind: 'live', root: '/repo' }, unit }); });
    const undo = readPresentationNotice()?.undo;
    if (!undo) throw new Error('Undo must be available');
    let completion: unknown;
    await act(async () => { completion = undo.run(); });
    await vi.waitFor(() => expect(homes.artifacts(serverId).list()).toHaveLength(1));
    expect(readPresentationNotice()).toMatchObject({ message: t('approvals.waitingForYou'), severity: 'info',
      approval: { artifactId: homes.artifacts(serverId).list()[0]!.id } });
    await vi.waitFor(() => expect(screen.findByTestId('presentation-notice-approval')).not.toBeNull());
    expect(disk).toBe(original.replace('Welcome', 'Hello'));
    expect(homes.requestsFor('/v1/actions/workspace.files.replace')).toHaveLength(0);
    const artifactId = homes.artifacts(serverId).list()[0]!.id;
    expect(await decideApprovalAsInbox(serverId, artifactId, 'approve')).toMatchObject({ ok: true });
    await act(async () => { publishHomeAccountChange(serverId, [artifactId]); });
    await vi.waitFor(async () => expect(await completion).toEqual({ success: true }));
    expect(new TextEncoder().encode(disk)).toEqual(new TextEncoder().encode(original));
    expect(readPresentationNotice()).toMatchObject({ message: t('hunkReview.noticeUndone') });
  });

  it('continues whole-file binary Undo after approval without changing the preimage', async () => {
    await homes.requireUiApproval(serverId, 'daemon.filesystem.writeFile');
    await installOwnMachineApprovalReplayBoundary({ harness: homes, serverId, accountId: 'review-account', machineId: 'm1' });
    const screen = await renderScreen(React.createElement(PresentationNoticeHost));
    let disk = 'discarded';
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'restored', hashBefore: beforeHash,
      hashAfter: afterHash, previous: { inlineBase64: 'AP+ADQo=' } }] }, (request: unknown) => {
      expect(request).toMatchObject({ payload: { content: 'AP+ADQo=', expectedHash: afterHash } });
      disk = 'AP+ADQo=';
      return { success: true, hash: beforeHash };
    });
    const result = await discardChange(input());
    if (!result.ok || !result.undo) throw new Error('Undo must be available');
    let completion: ReturnType<NonNullable<typeof result.undo>> | undefined;
    await act(async () => { completion = result.undo!(); });
    await vi.waitFor(() => expect(readPresentationNotice()?.approval?.artifactId).toBeDefined());
    expect(screen.findByTestId('presentation-notice-approval')).not.toBeNull();
    expect(disk).toBe('discarded');
    const artifactId = readPresentationNotice()!.approval!.artifactId;
    expect(await decideApprovalAsInbox(serverId, artifactId, 'approve')).toMatchObject({ ok: true });
    await act(async () => { publishHomeAccountChange(serverId, [artifactId]); });
    await vi.waitFor(async () => expect(await completion).toEqual({ success: true }));
    expect(disk).toBe('AP+ADQo=');
    expect(readPresentationNotice()).toMatchObject({ message: messages.undone });
  });

  it('refuses selected-hunk Undo after a later write through the restore owner', async () => {
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'reverted', hashBefore: beforeHash, hashAfter: afterHash,
      inverseEdits: [{ startUtf16: 1, deleteLength: 3, insertText: 'old', originalText: 'new' }] }] },
      { ok: true, results: [{ path: 'a.txt', status: 'changed' }] });
    const result = await discardChange(input());
    if (!result.ok || !result.undo) throw new Error('Undo must be available');
    expect(await result.undo()).toEqual({ success: false });
    expect(readPresentationNotice()).toMatchObject({ message: messages.undo_conflict });
    expect(rpc.requests).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({
      operation: { kind: 'restore', files: [expect.objectContaining({ path: 'a.txt', expectedHash: afterHash })] },
    }) })]));
    expect(rpc.responses).toHaveLength(0);
  });

  it('restores binary previous bytes without decoding as text and refuses a guarded Undo conflict', async () => {
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'restored', hashBefore: beforeHash, hashAfter: afterHash,
      previous: { inlineBase64: 'AP+ADQo=' } }] }, { success: false, errorCode: 'hash_mismatch', error: 'changed' });
    const { entry, ...rest } = input();
    const { changeKeys: _keys, ...wholeFile } = entry;
    const result = await discardChange({ ...rest, entry: wholeFile });
    if (!result.ok || !result.undo) throw new Error('Undo must be available');
    expect(await result.undo()).toEqual({ success: false });
    expect(rpc.requests).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({
      content: 'AP+ADQo=', expectedHash: afterHash,
    }) })]));
    expect(readPresentationNotice()).toMatchObject({ message: 'undo conflict' });
    expect(await result.undo()).toEqual({ success: false });
    expect(rpc.responses).toHaveLength(0);
  });

  it('keeps a completed Discard and its Undo when note delivery fails', async () => {
    rpc.responses.push({ success: true, noteDelivery: { status: 'failed' }, entries: [{ path: 'a.txt', status: 'reverted',
      hashBefore: beforeHash, hashAfter: afterHash, inverseEdits: [{ startUtf16: 1, deleteLength: 3, insertText: 'old', originalText: 'new' }] }] });
    const result = await discardChange(input());
    expect(result).toMatchObject({ ok: true, noteDelivery: 'failed' });
    expect(result.ok && result.undo).toBeTypeOf('function');
    expect(readPresentationNotice()).toMatchObject({ severity: 'error', message: messages.note_failed, undo: { label: 'undo' } });
    expect(rpc.responses).toHaveLength(0);
  });

  it.each(['dismissed', 'replaced', 'same-key replacement'] as const)('retires a %s notice inverse without removing its successor', async retirement => {
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'reverted', hashBefore: beforeHash, hashAfter: afterHash,
      inverseEdits: [{ startUtf16: 1, deleteLength: 3, insertText: 'old', originalText: 'new' }] }] });
    const result = await discardChange(input());
    if (!result.ok || !result.undo) throw new Error('Undo must be available');
    const original = readPresentationNotice()!;
    if (retirement === 'dismissed') retirePresentationNotice(original.key);
    else publishPresentationNotice({ key: retirement === 'same-key replacement' ? original.key : 'new-operation', message: 'new notice', severity: 'info' });
    const successor = readPresentationNotice();
    const requestsBeforeUndo = rpc.requests.length;
    expect(await result.undo()).toEqual({ success: false });
    expect(rpc.requests).toHaveLength(requestsBeforeUndo);
    expect(readPresentationNotice()).toBe(successor);
  });

  it('removes keyboard Undo availability as soon as its notice is dismissed', async () => {
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'reverted', hashBefore: beforeHash, hashAfter: afterHash,
      inverseEdits: [{ startUtf16: 1, deleteLength: 3, insertText: 'old', originalText: 'new' }] }] });
    const result = await discardChange(input());
    const hook = await renderHook(() => useHunkDiscard({ scope: { machineId: 'm1', rootPath: '/repo', serverId },
      sessionId: null, machineName: 'Machine', unreachable: false, refresh: () => {} }));
    await act(async () => { hook.getCurrent().remember(result); });
    expect(hook.getCurrent().undoAvailable).toBe(true);
    await act(async () => { retirePresentationNotice(); });
    expect(hook.getCurrent().undoAvailable).toBe(false);
    const count = rpc.requests.length;
    await act(async () => { hook.getCurrent().undo(); });
    expect(rpc.requests).toHaveLength(count);
  });

  it('retires a just-remembered inverse in the same React batch', async () => {
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'restored', hashBefore: beforeHash, hashAfter: afterHash,
      previous: { inlineBase64: 'b2xkCg==' } }] });
    const result = await discardChange(input());
    if (!result.ok || !result.undo) throw new Error('Undo must be available');
    const hook = await renderHook(() => useHunkDiscard({ scope: { machineId: 'm1', rootPath: '/repo', serverId },
      sessionId: null, machineName: 'Machine', unreachable: false, refresh: () => {} }));
    await act(async () => { hook.getCurrent().remember(result); hook.getCurrent().retireUndo(); });
    expect(hook.getCurrent().undoAvailable).toBe(false);
    expect(readPresentationNotice()).toBeNull();
    const count = rpc.requests.length;
    expect(await result.undo()).toEqual({ success: false });
    expect(rpc.requests).toHaveLength(count);
  });

  it('retains File-page restore Undo on the same file until used, and retires it on file change or unmount', async () => {
    const initialProps: { path: string; rootPath?: string } = { path: 'a.txt' };
    const hook = await renderHook(({ path, rootPath = '/repo' }: { path: string; rootPath?: string }) => useFileChangesReview({
      scope: { machineId: 'm1', rootPath, serverId }, filePath: path,
      liveDiff: '@@ -1 +1 @@\n-old\n+new\n', refreshLiveDiff: () => {}, contentHash: beforeHash,
      view: { changesScope: { kind: 'workingTree' } }, onChangesScopeChange: () => {}, active: true,
    }), { initialProps });
    const restore = async () => {
      rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'restored', hashBefore: beforeHash, hashAfter: afterHash,
        previous: { inlineBase64: 'b2xkCg==' } }] });
      await act(async () => { await hook.getCurrent().menuChanges.discardAll?.(); });
      expect(hook.getCurrent().undoAvailable).toBe(true);
      expect(hook.getCurrent().keyboard.undo).toBeTypeOf('function');
      expect(readPresentationNotice()?.undo).toBeDefined();
    };
    await restore();
    await hook.rerender();
    expect(hook.getCurrent().undoAvailable).toBe(true);
    rpc.responses.push({ success: true, hash: beforeHash });
    await act(async () => { hook.getCurrent().keyboard.undo?.(); });
    await vi.waitFor(() => expect(rpc.requests).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({
      content: 'b2xkCg==', expectedHash: afterHash,
    }) })])));
    expect(hook.getCurrent().undoAvailable).toBe(false);
    await restore();
    const fileUndo = readPresentationNotice()!.undo!.run;
    await hook.rerender({ path: 'b.txt' });
    expect(readPresentationNotice()).toBeNull();
    expect(await fileUndo()).toEqual({ success: false });
    await hook.rerender({ path: 'a.txt' });
    await restore();
    const previousCheckoutUndo = readPresentationNotice()!.undo!.run;
    await hook.rerender({ path: 'a.txt', rootPath: '/other-repo' });
    expect(readPresentationNotice()).toBeNull();
    expect(await previousCheckoutUndo()).toEqual({ success: false });
    await hook.rerender({ path: 'a.txt' });
    await restore();
    const unmountedUndo = readPresentationNotice()!.undo!.run;
    await hook.unmount();
    expect(readPresentationNotice()).toBeNull();
    expect(await unmountedUndo()).toEqual({ success: false });
    expect(rpc.responses).toHaveLength(0);
  });

  it('offers project per-change Ask through the existing detached run destination', async () => {
    const opened: DetailsTab[] = [];
    let liveEntry: Pick<ScmWorkingEntry, 'path' | 'kind' | 'hasIncludedDelta'> = { path: 'a.txt', kind: 'modified', hasIncludedDelta: false };
    const hook = await renderHook(() => {
      const getAskTargetContext = useAskSelectionTargetContext(React.useCallback(() => ({
        openDetailsTab: (tab: DetailsTab) => { opened.push(tab); },
      }), []));
      return useFileChangesReview({
        scope: { machineId: 'm1', rootPath: '/repo', serverId }, filePath: 'a.txt',
        liveDiff: '@@ -1 +1 @@\n-old\n+new\n', refreshLiveDiff: () => {},
        liveEntry,
        view: { changesScope: { kind: 'workingTree' } }, onChangesScopeChange: () => {}, active: true,
        getAskTargetContext,
      });
    });
    expect(hook.getCurrent().keyboard.askCurrent).toBeTypeOf('function');
    rpc.responses.push({ protocolVersion: 1, results: { 'tool.executionRuns': { ok: true, checkedAt: Date.now(),
      data: { protocolVersion: 2, features: { detachedScope: true, exactInputResults: true } } } } });
    await act(async () => { hook.getCurrent().keyboard.askCurrent?.(); });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ kind: 'executionRunLauncher', resource: {
      sessionId: null, workspace: { machineId: 'm1', cwd: '/repo' }, initialInstructions: expect.stringContaining('new'),
    } });
    expect(opened[0]?.resource).toMatchObject({ initialInstructions: expect.stringContaining('a.txt:1') });
    expect(rpc.responses).toHaveLength(0);
    // The real File-page hook feeds status to the same row/menu/keyboard owner without disabling Ask.
    const staleDiscard = hook.getCurrent().keyboard.discardCurrent;
    const requests = rpc.requests.length;
    liveEntry = { ...liveEntry, hasIncludedDelta: true };
    await hook.rerender();
    expect(hook.getCurrent().discardDisabledReason).toBeTruthy();
    await act(async () => { staleDiscard?.(); hook.getCurrent().keyboard.discardCurrent?.(); });
    expect(rpc.requests).toHaveLength(requests);
    expect(hook.getCurrent().keyboard.askCurrent).toBeTypeOf('function');
    liveEntry = { ...liveEntry, kind: 'added' };
    await hook.rerender();
    expect(hook.getCurrent().keyboard.discardCurrent).toBeUndefined();
    expect(hook.getCurrent().hunks.actions?.discard).toBeUndefined();
  });

  it('reports Undo note failure separately from the successful one-shot file write', async () => {
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'reverted', hashBefore: beforeHash, hashAfter: afterHash,
      inverseEdits: [{ startUtf16: 1, deleteLength: 3, insertText: 'old', originalText: 'new' }] }] },
      { ok: true, results: [{ path: 'a.txt', status: 'restored', hash: beforeHash }] });
    // The canonical sender refuses an unavailable Session; it must not turn an
    // already completed file write into a retryable mutation failure.
    const result = await discardChange({ ...input(), sessionTarget: { serverId, sessionId: 'unavailable-session' } });
    if (!result.ok || !result.undo) throw new Error('Undo must be available');
    expect(await result.undo()).toEqual({ success: true, noteDelivery: 'failed' });
    expect(await result.undo()).toEqual({ success: true, noteDelivery: 'failed' });
    expect(readPresentationNotice()).toMatchObject({ message: messages.note_failed, severity: 'error' });
    expect(rpc.responses).toHaveLength(0);
  });

  it('materializes exported Undo bytes before offering Undo and does not reopen the expiring descriptor later', async () => {
    const bytes = new Uint8Array([0, 255, 128, 13, 10]);
    const hasher = createTransferManifestHasher(); hasher.update(bytes);
    const manifestHash = hasher.digestManifestHash();
    const endpoint = 'http://127.0.0.1:46001/machine-transfers/direct/cHJldmlvdXM';
    let envelope: Awaited<ReturnType<typeof createEncryptedTransferChunkEnvelope>>;
    transfer.fetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/open')) {
        envelope = await createEncryptedTransferChunkEnvelope({ transferId: 'previous', sequence: 0, payload: bytes,
          recipientPublicKeyBase64: new Headers(init?.headers).get('x-happier-transfer-recipient-public-key')! });
        return new Response(JSON.stringify({ transferId: 'previous', totalChunks: 1, sizeBytes: bytes.length, manifestHash }), { headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/chunks/0')) return new Response(JSON.stringify({ transferId: 'previous', kind: 'chunk', sequence: 0, ...envelope }), { headers: { 'content-type': 'application/json' } });
      throw new Error('Unexpected transfer endpoint');
    });
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'restored', hashBefore: beforeHash, hashAfter: afterHash,
      previous: { export: { transferId: 'previous', name: 'a.txt', sizeBytes: bytes.length, manifestHash, expiresAt: Date.now() + 60_000,
        endpointCandidates: [{ kind: 'http', url: endpoint, expiresAt: Date.now() + 60_000 }] } } }] }, { success: true, hash: beforeHash });
    const result = await discardChange(input());
    expect(transfer.fetch).toHaveBeenCalled();
    expect(rpc.requests).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'daemon.directTransfer.export.release' })]));
    if (!result.ok || !result.undo) throw new Error('Materialized Undo must be available');
    transfer.fetch.mockClear(); transfer.fetch.mockRejectedValue(new Error('Descriptor expired'));
    expect(await result.undo()).toEqual({ success: true });
    expect(transfer.fetch).not.toHaveBeenCalled();
    expect(rpc.requests).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ content: 'AP+ADQo=', expectedHash: afterHash }) })]));
  });

  it('reports unavailable Undo after a failed preimage download without replaying the completed mutation', async () => {
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status: 'restored', hashBefore: beforeHash, hashAfter: afterHash,
      previous: { export: { transferId: 'previous', name: 'a.txt', sizeBytes: 1, manifestHash: `sha256:${'a'.repeat(64)}`,
        expiresAt: Date.now() + 60_000, endpointCandidates: [] } } }] });
    const result = await discardChange(input());
    expect(result).toMatchObject({ ok: true, undoUnavailable: true });
    expect(result).not.toHaveProperty('undo');
    expect(readPresentationNotice()).toMatchObject({ severity: 'error', message: messages.undo_unavailable });
    expect(rpc.responses).toHaveLength(0);
  });

  it.each([['FILE_CHANGED', 'moved_on'], ['CHANGE_MOVED_ON', 'moved_on'], ['INVALID_REQUEST', 'update_required']] as const)(
    'surfaces %s and refreshes without another mutation', async (errorCode, reason) => {
      rpc.responses.push({ success: false, errorCode, error: 'refused' });
      let refreshed = false;
      expect(await discardChange({ ...input(), refresh: async () => { refreshed = true; } })).toEqual({ ok: false, reason });
      expect(refreshed).toBe(true);
      expect(rpc.responses).toHaveLength(0);
      expect(readPresentationNotice()?.undo).toBeUndefined();
    });

  it.each(['recreated', 'kept_edited'] as const)('offers no Undo for %s when nothing was overwritten', async status => {
    rpc.responses.push({ success: true, entries: [{ path: 'a.txt', status, hashBefore: null, hashAfter: afterHash }] });
    const result = await discardChange(input());
    expect(result).toMatchObject({ ok: true, entry: { status } });
    expect(result.ok && result.fileReplaced).toBe(status !== 'kept_edited');
    expect(result).not.toHaveProperty('undo');
    expect(readPresentationNotice()?.undo).toBeUndefined();
  });
});
