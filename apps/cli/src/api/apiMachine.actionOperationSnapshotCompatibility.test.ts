import { logger } from '@/ui/logger';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { projectActionOperationSnapshotForV1Reader } from '@happier-dev/protocol/actions/operations/v1';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { ActionOperationSnapshotV1Schema as PredecessorSnapshotSchema } from '@/daemon/actionOperations/testFixtures/predecessorActionOperationV1';

import { createActionOperationSnapshotPublisher, emitActionOperationSnapshotV1 } from './apiMachine';

describe('Action operation snapshot producer compatibility', () => {
  beforeEach(() => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
      mode: 'e2ee', updatedAt: 1,
    } });
  });
  afterEach(() => vi.restoreAllMocks());
  it('retains released encrypted publication when the Home exposes persisted mode but no currentness endpoint', async () => {
    const accountId = 'older-account';
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url === 'https://older-home.example/v1/account/encryption/currentness')
        return { status: 404, data: { error: 'not_found' } };
      if (url === 'https://older-home.example/v1/account/encryption')
        return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      throw new Error(`Unexpected Home endpoint: ${url}`);
    });
    const contents: Parameters<typeof emitActionOperationSnapshotV1>[0]['content'][] = [];
    const publisher = createActionOperationSnapshotPublisher({ resolveAccountId: async () => accountId,
      serverBaseUrl: 'https://older-home.example', readCredentials: async () => ({ token, encryption: material }),
      publishContent: content => { contents.push(content); } });
    const snapshot: ActionOperationSnapshotV1 = { version: 1, operationId: 'older-operation', revision: 1,
      actionId: 'session.fork', state: 'accepted', scope: { accountId, machineId: 'machine-1' },
      title: 'Fork', createdAt: 1, cancellation: 'unsupported' };
    await publisher(snapshot);
    expect(contents).toHaveLength(1);
    const content = contents[0]!;
    expect(content.t).toBe('encrypted');
    if (content.t !== 'encrypted') return;
    expect(PredecessorSnapshotSchema.parse(openAccountScopedBlobCiphertext({
      kind: 'action_operation_snapshot', material, ciphertext: content.c,
    })?.value)).toEqual(snapshot);
  });
  it('publishes keyless Plain Script observations only after the exact Home admits the Account mode', async () => {
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const accountId = 'plain-account';
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    let credentials = { token, encryption: null };
    let mode: 'plain' | 'e2ee' = 'plain';
    let status = 200;
    let retireDuringModeRead = false;
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      expect(url).toBe('https://original-home.example/v1/account/encryption');
      expect(options?.headers?.Authorization).toBe(`Bearer ${token}`);
      if (retireDuringModeRead) credentials = {
        token: `e30.${Buffer.from(JSON.stringify({ sub: 'replacement-account' })).toString('base64url')}.signature`, encryption: null,
      };
      return { status, data: { mode, updatedAt: 1 } };
    });
    const emit = vi.fn();
    const publisher = createActionOperationSnapshotPublisher({
      resolveAccountId: async () => accountId,
      serverBaseUrl: 'https://original-home.example',
      readCredentials: async () => credentials,
      publishContent: content => emitActionOperationSnapshotV1({ socket: { emit }, machineId: 'machine', content }),
    });
    const domainRef = { kind: 'projectCommand', purpose: 'script',
        serverId: 'original-home', machineId: 'worker', workspaceRefId: 'copied-target', cwd: '/target',
        sourceWorkspace: { serverId: 'original-home', machineId: 'source', workspaceId: 'selected-source', rootPath: '/source' },
        script: { name: 'check', source: { kind: 'command', command: 'check' } } } as const;
    const accepted: ActionOperationSnapshotV1 = { version: 1, operationId: 'script', revision: 1,
      actionId: 'projects.script.run', state: 'accepted', scope: { accountId, machineId: 'machine' },
      title: 'Run Script', createdAt: 1, cancellation: 'supported', domainRef };
    const running = { ...accepted, revision: 2, state: 'running' as const, startedAt: 2,
      domainRef: { ...domainRef, terminalId: 'terminal' } };
    const failed = { ...running, revision: 3, state: 'failed' as const, settledAt: 7,
      error: { errorCode: 'project_command_step_failed', error: 'Command failed' },
      domainRef: { ...running.domainRef, exitCode: 7 } };
    for (const snapshot of [accepted, running, failed]) await publisher(snapshot);
    expect(emit.mock.calls.map(call => call[1]), JSON.stringify(warnings.mock.calls)).toEqual([accepted, running, failed].map(snapshot => ({
      type: 'action-operation-updated', machineId: 'machine', content: { t: 'plain', v: projectActionOperationSnapshotForV1Reader(snapshot) },
    })));
    for (const call of emit.mock.calls) expect(PredecessorSnapshotSchema.safeParse(call[1].content.v).success).toBe(true);
    expect(get).toHaveBeenCalled();
    emit.mockClear();
    mode = 'e2ee';
    await publisher(failed);
    status = 404;
    await publisher(failed);
    status = 200; mode = 'plain';
    credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'replacement-account' })).toString('base64url')}.signature`, encryption: null };
    await publisher(failed);
    expect(emit).not.toHaveBeenCalled();
    credentials = { token, encryption: null };
    retireDuringModeRead = true;
    await publisher(failed);
    expect(emit).not.toHaveBeenCalled();
  });
  it('publishes rich owner observations through the closed predecessor reader without changing current custody', async () => {
    const accountId = 'account-a';
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const material = { type: 'legacy' as const, secret: new Uint8Array(32) };
    const ciphertexts: string[] = [];
    const emit = vi.fn();
    const publications: Promise<void>[] = [];
    // Credential storage and socket transport are the substituted boundaries;
    // actual runtime, runner, store, Account cipher and predecessor parser run.
    const publisher = createActionOperationSnapshotPublisher({
      resolveAccountId: async () => accountId,
      serverBaseUrl: 'https://encrypted-home.example',
      readCredentials: async () => ({ token, encryption: material }),
      publishContent: content => {
        if (content.t !== 'encrypted') throw new Error('E2EE Account must publish encrypted content');
        emitActionOperationSnapshotV1({ socket: { emit }, machineId: 'machine-a', content });
        ciphertexts.push(content.c);
      },
    });
    let nextId = 0;
    const runtime = createHostActionOperationRuntime({ machineId: 'machine-a',
      resolveAccountId: async () => accountId, generateOperationId: () => `operation-${++nextId}`,
      publishSnapshot: snapshot => { publications.push(publisher(snapshot)); },
    });
    const details = { kind: 'pendingApproval' as const, code: 'project_setup_consent_required',
      reviewedEffectDigest: 'reviewed-effect', reviewedEffect: { commands: ['install'] } };
    await runtime.observeExecution({ actionId: 'projects.prepare', input: {}, execute: async context => {
      context.operationOwnerUpdate.update({ domainRef: { kind: 'projectCommand', purpose: 'setup',
        serverId: 'home', machineId: 'machine-a', workspaceRefId: 'workspace', cwd: '/project' } });
      return { ok: false, errorCode: details.code, error: 'Setup needs review', details };
    } });
    await runtime.observeExecution({ actionId: 'machines.managed.acquire', input: {}, execute: async context => {
      context.operationOwnerUpdate.update({ domainRef: { kind: 'managedMachine', id: 'managed-row',
        bootstrapTask: { id: 'bootstrap', taskKind: 'remote.ssh.bootstrapMachine.v1' } } });
      return { ok: true, result: { machineId: 'managed-row' } };
    } });
    await runtime.observeExecution({ actionId: 'session.fork', input: { requestId: 'fork-request', strategy: 'native' },
      execute: async () => ({ ok: true, result: { sessionId: 'forked-session' } }) });
    await Promise.all(publications);

    const scope = { accountId, machineId: 'machine-a' };
    const held = runtime.store.get(scope, 'operation-1')!;
    expect(held).toMatchObject({ domainRef: { kind: 'projectCommand' }, error: { details } });
    expect(runtime.store.get(scope, 'operation-2')).toMatchObject({ domainRef: { kind: 'managedMachine' } });
    const opened = ciphertexts.map(ciphertext => openAccountScopedBlobCiphertext({
      kind: 'action_operation_snapshot', material, ciphertext,
    })?.value);
    expect(opened.length).toBeGreaterThan(0);
    for (const ciphertext of ciphertexts) expect(emit).toHaveBeenCalledWith('action-operation-updated', {
      type: 'action-operation-updated', machineId: 'machine-a', content: { t: 'encrypted', c: ciphertext },
    });
    for (const snapshot of opened) expect(PredecessorSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(opened).toContainEqual(expect.objectContaining({ operationId: 'operation-1', state: 'failed',
      error: { errorCode: details.code, error: 'Setup needs review' } }));
    expect(opened).toContainEqual(expect.objectContaining({ operationId: 'operation-3', state: 'succeeded',
      domainRef: { kind: 'forkRequest', id: 'fork-request', strategy: 'native' }, result: { sessionId: 'forked-session' } }));
    expect(await runtime.handlers.getV2({ operationId: 'operation-1' }))
      .toEqual({ kind: 'found', operation: held });
    expect(runtime.store.get(scope, 'operation-1')).toBe(held);
  });
  it('emits exactly the immutable released 0.2.11 envelope once', () => {
    const emit = vi.fn();

    emitActionOperationSnapshotV1({
      socket: { emit },
      machineId: 'machine-1',
      content: { t: 'encrypted', c: 'sealed-snapshot' },
    });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('action-operation-updated', {
      type: 'action-operation-updated',
      machineId: 'machine-1',
      content: { t: 'encrypted', c: 'sealed-snapshot' },
    });
  });
  it('withholds queued publication after credentials move to another Account and accepts same-Account refresh', async () => {
    const token = (subject: string, refresh: string) => `e30.${Buffer.from(JSON.stringify({ sub: subject, refresh })).toString('base64url')}.signature`;
    const publishContent = vi.fn();
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let subject = 'account-a';
    let refresh = 'first';
    const publisher = createActionOperationSnapshotPublisher({
      resolveAccountId: async () => 'account-a',
      serverBaseUrl: 'https://encrypted-home.example',
      readCredentials: async () => ({ token: token(subject, refresh), encryption: { type: 'legacy', secret: new Uint8Array(32) } }),
      publishContent,
    });
    const snapshot: ActionOperationSnapshotV1 = {
      version: 1, operationId: 'operation-a', revision: 1, actionId: 'session.fork', state: 'accepted',
      scope: { accountId: 'account-a', machineId: 'machine-a' }, title: 'Fork', createdAt: 1, cancellation: 'unsupported',
    };
    try {
      const queued = publisher(snapshot);
      subject = 'account-b';
      await queued;
      expect(publishContent).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalled();
      subject = 'account-a'; refresh = 'rotated-token';
      await publisher({ ...snapshot, revision: 2 });
      expect(publishContent).toHaveBeenCalledOnce();
    } finally { warning.mockRestore(); }
  });

});
