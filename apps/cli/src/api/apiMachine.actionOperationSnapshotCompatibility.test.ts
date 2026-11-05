import { logger } from '@/ui/logger';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { ActionOperationSnapshotV1Schema, projectActionOperationSnapshotForV1Reader } from '@happier-dev/protocol/actions/operations/v1';
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
  it.each(['plain', 'e2ee'] as const)('waits for Home admission of the exact %s terminal snapshot without blocking progress', async mode => {
    const accountId = 'setup-owner';
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode, updatedAt: 1 } });
    let acknowledge!: (accepted: boolean) => void;
    const homeAnswer = new Promise<boolean>(resolve => { acknowledge = resolve; });
    const emit = vi.fn();
    const emitWithAck = vi.fn(async (_event: string, _payload: {
      content: Parameters<typeof emitActionOperationSnapshotV1>[0]['content'];
    }) => homeAnswer);
    // This transport fixture implements only the snapshot event of Socket.IO's generic API.
    const boundary = { emit, emitWithAck, connected: true } as unknown as
      NonNullable<Parameters<typeof emitActionOperationSnapshotV1>[0]['socket']>;
    const dependencies = { resolveAccountId: async () => accountId, serverBaseUrl: 'https://setup-home.example',
      readCredentials: async () => ({ token, encryption: mode === 'plain' ? null : material }),
      publishContent: (content: Parameters<typeof emitActionOperationSnapshotV1>[0]['content']) => {
        emitActionOperationSnapshotV1({ socket: boundary, machineId: 'machine', content });
      },
      publishContentAcknowledged: async (content: Parameters<typeof emitActionOperationSnapshotV1>[0]['content']) =>
        await emitActionOperationSnapshotV1({ socket: boundary, machineId: 'machine', content, acknowledge: true }) === true,
    };
    const publisher = createActionOperationSnapshotPublisher(dependencies);
    const snapshot: ActionOperationSnapshotV1 = { version: 1, operationId: 'setup', revision: 3,
      actionId: 'machines.setup.apply', state: 'succeeded', scope: { accountId, machineId: 'machine' },
      title: 'Apply setup', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported', result: { membershipApplied: true } };
    let settled = false;
    const publication = publisher.acknowledge(snapshot).then(value => { settled = true; return value; });
    await publisher({ ...snapshot, operationId: 'unrelated', state: 'running', revision: 2 });
    expect(emit).toHaveBeenCalledOnce();
    expect(emitWithAck).toHaveBeenCalledOnce();
    const payload = emitWithAck.mock.calls[0]![1];
    const expected = projectActionOperationSnapshotForV1Reader(snapshot);
    const opened = payload.content.t === 'plain' ? payload.content.v : openAccountScopedBlobCiphertext({
      kind: 'action_operation_snapshot', material, ciphertext: payload.content.c,
    })?.value;
    expect(opened).toEqual(expected);
    expect(settled).toBe(false);
    acknowledge(true);
    await expect(publication).resolves.toBe(true);
  });
  it.each(['plain', 'e2ee'] as const)('publishes current reboot attendance and before-basis through the existing %s Account push', async mode => {
    const accountId = 'reboot-owner';
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode, updatedAt: 1 } });
    const contents: Parameters<typeof emitActionOperationSnapshotV1>[0]['content'][] = [];
    const publisher = createActionOperationSnapshotPublisher({ resolveAccountId: async () => accountId,
      serverBaseUrl: 'https://original-home.example', readCredentials: async () => ({ token, encryption: mode === 'plain' ? null : material }),
      publishContent: content => { contents.push(content); } });
    const snapshot: ActionOperationSnapshotV1 = { version: 1, operationId: 'reboot-operation', revision: 3,
      actionId: 'machines.reboot', state: 'running', scope: { accountId, machineId: 'machine' },
      title: 'Reboot', createdAt: 1, startedAt: 2, cancellation: 'unsupported',
      domainRef: { kind: 'machineReboot', serverId: 'home', machineId: 'machine', installationId: 'installation',
        task: { id: 'task', taskKind: 'machine.reboot.v1', prompt: { kind: 'sudo.password', adminUsername: 'operator' } },
        basis: { bootedAt: 1000, expectedRunningServiceIds: ['service'], expectedRunningServicesKnown: true, dispatchStarted: true } } };
    await publisher(snapshot);
    expect(contents).toHaveLength(1);
    const content = contents[0]!;
    const opened = content.t === 'plain' ? content.v : openAccountScopedBlobCiphertext({
      kind: 'action_operation_snapshot', material, ciphertext: content.c,
    })?.value;
    expect(ActionOperationSnapshotV1Schema.parse(opened)).toEqual(snapshot);
    // The actual supported predecessor reader closes unknown domain kinds.
    // Its UI opener safeParses and returns null, dropping only this new Action;
    // existing Actions still use their unchanged predecessor projection below.
    expect(PredecessorSnapshotSchema.safeParse(opened).success).toBe(false);
  });
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
    expect(emit).toHaveBeenCalledOnce();
    // Rotation takes effect at the next batch admission; the admitted batch finishes.
    await publisher(failed);
    expect(emit).toHaveBeenCalledOnce();
  });
  it('collapses queued revisions to the terminal snapshot instead of delivering stale progress first', async () => {
    const accountId = 'plain-account';
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    let releaseModeRead: (() => void) | undefined;
    const modeRead = new Promise<void>(resolve => { releaseModeRead = resolve; });
    const get = vi.spyOn(axios, 'get').mockImplementationOnce(async () => {
      await modeRead;
      return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    }).mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
    const publishContent = vi.fn();
    const readCredentials = vi.fn(async () => ({ token, encryption: null }));
    const publisher = createActionOperationSnapshotPublisher({ resolveAccountId: async () => accountId,
      serverBaseUrl: 'https://home.example', readCredentials, publishContent });
    const accepted: ActionOperationSnapshotV1 = { version: 1, operationId: 'power', revision: 1,
      actionId: 'machines.managed.power.set', state: 'accepted', scope: { accountId, machineId: 'controller' },
      title: 'Suspend', createdAt: 1, cancellation: 'supported' };
    const running: ActionOperationSnapshotV1 = { ...accepted, revision: 2, state: 'running', startedAt: 2 };
    const progress: ActionOperationSnapshotV1 = { ...running, revision: 3,
      progress: { kind: 'phase', phase: 'managed.intent.native-effect', label: 'Applying native machine intent' } };
    const succeeded: ActionOperationSnapshotV1 = { ...progress, revision: 4, state: 'succeeded', settledAt: 4,
      result: { managedId: 'managed' } };

    const publications = [publisher(accepted), publisher(running), publisher(progress), publisher(succeeded)];
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(publishContent).not.toHaveBeenCalled();
    releaseModeRead!();
    await Promise.all(publications);

    expect(get).toHaveBeenCalledTimes(2);
    expect(readCredentials, 'one credential read per drained batch').toHaveBeenCalledTimes(get.mock.calls.length);
    expect(publishContent.mock.calls.map(([content]) => content.t === 'plain' ? content.v : null)).toEqual([
      projectActionOperationSnapshotForV1Reader(accepted),
      projectActionOperationSnapshotForV1Reader(succeeded),
    ]);
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
  it('finishes admitted publication and withholds the next foreign-Account batch while accepting same-Account refresh', async () => {
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
      expect(publishContent).toHaveBeenCalledOnce();
      await publisher({ ...snapshot, revision: 2 });
      expect(publishContent).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalled();
      subject = 'account-a'; refresh = 'rotated-token';
      await publisher({ ...snapshot, revision: 3 });
      expect(publishContent).toHaveBeenCalledTimes(2);
    } finally { warning.mockRestore(); }
  });

});
