import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, symlink, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { Machine } from '@/api/types';
import { ApiMachineClient } from '@/api/apiMachine';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonLspQueryResponseSchema, DaemonLspRestartResponseSchema, DaemonLspSyncResponseSchema, DaemonLspWatchResponseSchema } from '@happier-dev/protocol/machines/languageIntelligence';
import { registerSessionHandlers } from './registerSessionHandlers';
import { registerLanguageIntelligenceHandlers } from './languageIntelligence';
import { createLanguageServerHost } from '@/lsp/languageServerHost';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { configuration } from '@/configuration';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { accountSettingsParse } from '@happier-dev/protocol';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

describe('language intelligence registered Machine transport', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  async function fixture() {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-lsp-rpc-'));
    roots.push(rootPath);
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
    registerLanguageIntelligenceHandlers(registrar, rootPath, { accessPolicy: { kind: 'restrictedRoots', roots: [rootPath] } });
    const call = async (method: string, input: unknown, signal?: AbortSignal) => {
      const handler = handlers.get(method);
      expect(handler, `transport registration installs ${method}`).toBeDefined();
      if (!handler) throw new Error('Missing language intelligence handler');
      return handler(input, signal ? { signal } : undefined);
    };
    return { rootPath, call };
  }

  it('registers semantic mutations only through Action admission and rejects a foreign operation', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-lsp-edit-action-'));
    roots.push(rootPath);
    await writeFile(join(rootPath, 'a.ts'), 'old');
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
    const host = createLanguageServerHost({ readCurrentContributionRegistry: () => null });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      languageIntelligenceApply: ({ request }, context) => host.apply(request, { signal: context.signal }) });
    const request = { rootPath, path: 'a.ts', operation: { kind: 'rename', files: [{ path: 'a.ts',
      expectedHash: createHash('sha256').update('old').digest('hex'), edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: 'next' }],
    }] } };
    const context = { signal: new AbortController().signal, localActionContext: { surface: 'ui', authority: 'present_user' } } as const;
    try {
      registerLanguageIntelligenceHandlers(registrar, rootPath, { machineId: 'machine' });
      expect(await handlers.get(RPC_METHODS.DAEMON_LSP_RENAME_APPLY)!(request, context)).toMatchObject({ ok: false });
      expect(await readFile(join(rootPath, 'a.ts'), 'utf8')).toBe('old');
      registerLanguageIntelligenceHandlers(registrar, rootPath, { machineId: 'machine', host, resolveActionExecutor: () => executor });
      expect(await handlers.get(RPC_METHODS.DAEMON_LSP_FILE_RENAME_APPLY)!(request, context)).toMatchObject({ ok: false, errorCode: 'invalid_action_transport_input' });
      expect(await handlers.get(RPC_METHODS.DAEMON_LSP_RENAME_APPLY)!(createTargetedActionRpcRequestV1(request, { kind: 'machine', machineId: 'machine' }), context))
        .toMatchObject({ ok: true, results: [{ status: 'replaced' }] });
      expect(await readFile(join(rootPath, 'a.ts'), 'utf8')).toBe('next');
    } finally { await host.dispose(); }
  });

  it('admits format/import Actions through their own routes and preserves guarded writes and inverse edits', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-lsp-format-action-'));
    roots.push(rootPath);
    await writeFile(join(rootPath, 'a.ts'), 'old');
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
    const host = createLanguageServerHost({ readCurrentContributionRegistry: () => null });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      languageIntelligenceApply: ({ request }, context) => host.apply(request, { signal: context.signal }) });
    const context = { signal: new AbortController().signal, localActionContext: { surface: 'ui', authority: 'present_user' } } as const;
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
    const files = [{ path: 'a.ts', expectedHash: createHash('sha256').update('old').digest('hex'), edits: [{ range, text: 'new' }] }];
    try {
      registerLanguageIntelligenceHandlers(registrar, rootPath, { machineId: 'machine', host, resolveActionExecutor: () => executor });
      const format = handlers.get('daemon.lsp.format.apply.v1');
      const imports = handlers.get('daemon.lsp.imports.organize.apply.v1');
      expect(format).toBeDefined();
      expect(imports).toBeDefined();
      if (!format || !imports) throw new Error('Missing format/import Action routes');
      const request = { rootPath, path: 'a.ts', operation: { kind: 'format', files } };
      expect(await imports(createTargetedActionRpcRequestV1(request, { kind: 'machine', machineId: 'machine' }), context))
        .toMatchObject({ ok: false, errorCode: 'invalid_action_transport_input' });
      expect(await readFile(join(rootPath, 'a.ts'), 'utf8')).toBe('old');
      for (const [handler, kind] of [[format, 'format'], [imports, 'organizeImports']] as const) {
        expect(await handler(createTargetedActionRpcRequestV1({ rootPath, path: 'a.ts',
          operation: { kind, files: [{ ...files[0], renameTo: 'moved.ts' }] } }, { kind: 'machine', machineId: 'machine' }), context))
          .toMatchObject({ status: 'error', errorCode: 'invalid_request' });
        expect(await readFile(join(rootPath, 'a.ts'), 'utf8')).toBe('old');
        await expect(readFile(join(rootPath, 'moved.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(await format(createTargetedActionRpcRequestV1(request, { kind: 'machine', machineId: 'machine' }), context))
        .toMatchObject({ ok: true, results: [{ status: 'replaced', edits: [{ originalText: 'old', insertText: 'new' }] }] });
      expect(await readFile(join(rootPath, 'a.ts'), 'utf8')).toBe('new');
      expect(await imports(createTargetedActionRpcRequestV1({ rootPath, path: 'a.ts', operation: { kind: 'organizeImports', files } },
        { kind: 'machine', machineId: 'machine' }), context)).toMatchObject({ ok: true, results: [{ status: 'changed' }] });
      expect(await readFile(join(rootPath, 'a.ts'), 'utf8')).toBe('new');
    } finally { await host.dispose(); }
  });

  it('settles admitted language mutations through the credentialed CLI factories and native guarded writer', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-lsp-native-action-' }, async () => {
      const rootPath = await mkdtemp(join(tmpdir(), 'happier-lsp-native-action-'));
      roots.push(rootPath);
      await writeFile(join(rootPath, 'a.ts'), 'old');
      const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
      const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
      const client = new ApiMachineClient(token, { id: 'machine', encryptionKey: new Uint8Array(32).fill(7),
        encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
      const nativeEffect = {
        languageIntelligenceApply: client.createLanguageIntelligenceApplyActionExecutor(configuration.activeServerId),
      } satisfies Pick<ActionExecutorDeps, 'languageIntelligenceApply'>;
      const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
        'code.rename.apply': ['ui'], 'code.file.rename.apply': ['ui'], 'code.codeAction.apply': ['ui'],
      } });
      const accountSettings = accountSettingsParse({ actionsSettingsV1: actionsSettings });
      const executor = createCliActionExecutorFromCredentials({ credentials, ...nativeEffect,
        readCredentials: async () => credentials,
        serverId: configuration.activeServerId, serverApiUrl: 'http://127.0.0.1:1',
        actionsSettingsProvider: { getActionsSettings: () => actionsSettings, getAccountSettings: () => accountSettings },
        machineActionDirectTargetTransport: { machineId: 'machine', invoke: client.invokeLocalMachineAction.bind(client) },
      });
      client.setRPCHandlers({ spawnSession: async () => ({ type: 'error', errorCode: 'SPAWN_FAILED', errorMessage: 'unused' }),
        stopSession: async () => true, requestShutdown: () => {} }, { externalActionIngressOwner: {
        currentServerId: configuration.activeServerId, executor, resolveTarget: async () => ({ kind: 'machine', machineId: 'machine' }),
      } });
      const controller = new AbortController();
      const invoke = (method: string, request: unknown) => client.invokeLocalMachineAction(method,
        createTargetedActionRpcRequestV1(request, { kind: 'machine', machineId: 'machine' }),
        { signal: controller.signal, localActionContext: { surface: 'ui', authority: 'present_user' },
          // The authenticated Home ingress is the boundary fixture. Action input
          // cannot supply this requester identity; all dispatch/effects stay real.
          rpcContext: { machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({ actorAccountId: 'owner',
            custodianAccountId: 'owner', machineId: 'machine', installationId: '11111111-1111-4111-8111-111111111111',
            role: 'manage', encryptionMode: 'plain' }) },
        });
      const hash = (text: string) => createHash('sha256').update(text).digest('hex');
      const file = { path: 'a.ts', expectedHash: hash('old'), edits: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: 'next' },
      ] };
      let pending: Promise<unknown> | undefined;
      try {
        let outcome: unknown;
        pending = invoke(RPC_METHODS.DAEMON_LSP_RENAME_APPLY, { rootPath, path: 'a.ts', operation: { kind: 'rename', files: [file] } })
          .then(result => { outcome = result; });
        // Observe settlement before awaiting the request, so a recursive self-RPC
        // fails as an unresolved Action and can still be cancelled in cleanup.
        await vi.waitFor(() => expect(outcome, `Native apply outcome: ${JSON.stringify(outcome)}`)
          .toMatchObject({ ok: true, results: [{ status: 'replaced' }] }));
        await pending;
        expect(await readFile(join(rootPath, 'a.ts'), 'utf8')).toBe('next');
        expect(await invoke(RPC_METHODS.DAEMON_LSP_FILE_RENAME_APPLY, { rootPath, path: 'a.ts', operation: { kind: 'fileRename',
          files: [{ path: 'a.ts', expectedHash: hash('next'), edits: [], renameTo: 'moved.ts' }],
        } })).toMatchObject({ ok: true, results: [{ status: 'replaced', renameTo: 'moved.ts' }] });
        expect(await readFile(join(rootPath, 'moved.ts'), 'utf8')).toBe('next');
        expect(await invoke(RPC_METHODS.DAEMON_LSP_CODE_ACTION_APPLY, { rootPath, path: 'moved.ts', operation: { kind: 'codeAction',
          expectedHash: hash('old'), action: { serverId: 'fixture/server', title: 'Stale fix', hasCommand: false,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, files: [] },
        } })).toMatchObject({ status: 'error', errorCode: 'stale_query' });
        expect(await readFile(join(rootPath, 'moved.ts'), 'utf8')).toBe('next');
      } finally {
        controller.abort();
        try { await pending; }
        finally { await client.shutdown(); }
      }
    });
  });

  it('exposes typed no-server behavior through the transport and real process host', async () => {
    const { rootPath, call } = await fixture();
    const opened = await call(RPC_METHODS.DAEMON_LSP_SYNC, { rootPath,
      op: { op: 'open', path: 'file.p7-no-server', languageId: 'p7-no-server', version: 0, text: '', unsaved: false } });
    expect(DaemonLspSyncResponseSchema.parse(opened)).toEqual({ status: 'unavailable', reason: 'no_capable_server' });
    expect(DaemonLspQueryResponseSchema.parse(await call(RPC_METHODS.DAEMON_LSP_QUERY, {
      rootPath, path: 'file.p7-no-server', kind: 'hover', position: { line: 0, character: 0 },
    }))).toMatchObject({ status: 'unavailable' });
    expect(DaemonLspRestartResponseSchema.parse(await call(RPC_METHODS.DAEMON_LSP_RESTART, { rootPath }))).toMatchObject({ status: 'unavailable' });
    expect(DaemonLspWatchResponseSchema.parse(await call(RPC_METHODS.DAEMON_LSP_WATCH, { rootPath })))
      .toEqual({ status: 'ok', revision: 0, servers: [], diagnostics: {} });
  });

  it('serves LSP on the Machine ingress but never installs it on a foreground Session', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-lsp-machine-rpc-'));
    roots.push(rootPath);
    const previousWorkingDirectory = process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY;
    const machine: Machine = {
      id: 'machine-lsp-test', encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    };
    const session = new RpcHandlerManager({ scopePrefix: 'session-lsp-test', encryptionMode: 'plain' });
    const registration = registerSessionHandlers(session, rootPath, { sessionId: 'session-lsp-test' });
    let client: ApiMachineClient | undefined;
    try {
      process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY = rootPath;
      client = new ApiMachineClient('test-token', machine);
      const requests = [
        [RPC_METHODS.DAEMON_LSP_SYNC, { rootPath,
          op: { op: 'open', path: 'file.p7-no-server', languageId: 'p7-no-server', version: 0, text: '', unsaved: false } }],
        [RPC_METHODS.DAEMON_LSP_QUERY, { rootPath, path: 'file.p7-no-server', kind: 'documentSymbols' }],
        [RPC_METHODS.DAEMON_LSP_WATCH, { rootPath }],
        [RPC_METHODS.DAEMON_LSP_RESTART, { rootPath }],
      ] as const;
      const rpc = { invokeLocal: client.invokeLocalMachineAction.bind(client) };
      expect(DaemonLspSyncResponseSchema.parse(await rpc.invokeLocal(...requests[0])))
        .toEqual({ status: 'unavailable', reason: 'no_capable_server' });
      expect(DaemonLspQueryResponseSchema.parse(await rpc.invokeLocal(...requests[1])))
        .toMatchObject({ status: 'unavailable' });
      expect(DaemonLspWatchResponseSchema.parse(await rpc.invokeLocal(...requests[2])))
        .toEqual({ status: 'ok', revision: 0, servers: [], diagnostics: {} });
      expect(DaemonLspRestartResponseSchema.parse(await rpc.invokeLocal(...requests[3])))
        .toEqual({ status: 'unavailable', reason: 'session_unavailable' });
      for (const [method, request] of requests) {
        expect(await session.invokeLocal(method, request)).toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
      }
    } finally {
      await client?.shutdown();
      await registration.dispose();
      if (previousWorkingDirectory === undefined) delete process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY;
      else process.env.HAPPIER_MACHINE_RPC_WORKING_DIRECTORY = previousWorkingDirectory;
    }
  });

  it('rejects unknown process fields, traversals, and roots outside the filesystem authority', async () => {
    const { rootPath, call } = await fixture();
    const query = { rootPath, path: 'a.ts', kind: 'documentSymbols' };
    expect(await call(RPC_METHODS.DAEMON_LSP_QUERY, { ...query, executable: '/tmp/evil' })).toEqual({ status: 'error', errorCode: 'invalid_request' });
    expect(await call(RPC_METHODS.DAEMON_LSP_QUERY, { ...query, path: '../secret' })).toEqual({ status: 'error', errorCode: 'invalid_request' });
    expect(await call(RPC_METHODS.DAEMON_LSP_QUERY, { ...query, rootPath: join(rootPath, '..') })).toEqual({ status: 'error', errorCode: 'path_not_allowed' });
    const controller = new AbortController();
    controller.abort();
    expect(await call(RPC_METHODS.DAEMON_LSP_QUERY, query, controller.signal)).toEqual({ status: 'error', errorCode: 'cancelled' });
  });

  it.skipIf(process.platform === 'win32')('refuses a workspace-relative document whose symlink leaves the selected root', async () => {
    const { rootPath, call } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'happier-lsp-outside-'));
    roots.push(outside);
    await symlink(outside, join(rootPath, 'link'));
    expect(await call(RPC_METHODS.DAEMON_LSP_QUERY, { rootPath, path: 'link/secret.ts', kind: 'documentSymbols' }))
      .toEqual({ status: 'error', errorCode: 'path_not_allowed' });
  });
});
