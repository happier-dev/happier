import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonLspQueryResponseSchema, DaemonLspRestartResponseSchema, DaemonLspSyncResponseSchema, DaemonLspWatchResponseSchema } from '@happier-dev/protocol/machines/languageIntelligence';
import { registerSessionHandlers } from './registerSessionHandlers';
import { registerLanguageIntelligenceHandlers } from './languageIntelligence';
import { configureLanguageServerHost, createLanguageServerHost, disposeLanguageServerHost, readLanguageServerProcessRoots,
  type LanguageServerHostOptions } from '@/lsp/languageServerHost';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { accountSettingsParse } from '@happier-dev/protocol';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createFilesystemEffectAdmission } from './fileSystem/accessPolicy/filesystemEffectAdmission';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';

describe('language intelligence registered Machine transport', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it('keeps the registered LSP watch parked until transport cancellation', async () => {
    vi.useFakeTimers();
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-lsp-finite-watch-'));
    roots.push(rootPath);
    const host = createLanguageServerHost({ readCurrentContributionRegistry: () => null });
    const controller = new AbortController();
    const handlers = new Map<string, RpcHandler>();
    registerLanguageIntelligenceHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, rootPath, { host });
    const watch = handlers.get(RPC_METHODS.DAEMON_LSP_WATCH)!;
    try {
      const initial = DaemonLspWatchResponseSchema.parse(await watch({ rootPath }));
      if (initial.status !== 'ok') throw new Error('Missing initial LSP watch snapshot');
      let settled = false;
      const pending = Promise.resolve(watch({ rootPath, sinceRevision: initial.revision }, { signal: controller.signal })).then(response => {
        settled = true;
        return DaemonLspWatchResponseSchema.parse(response);
      });
      await vi.advanceTimersByTimeAsync(24_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      controller.abort();
      expect(await pending).toEqual({ status: 'error', errorCode: 'cancelled' });
    } finally { controller.abort(); await host.dispose(); vi.useRealTimers(); }
  });

  it('preserves the filesystem admission cause through every strict LSP response reader', async () => {
    const handlers = new Map<string, RpcHandler>();
    registerLanguageIntelligenceHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, '/workspace', {
      effectAdmission: createFilesystemEffectAdmission(),
    });
    for (const [method, schema] of [
      [RPC_METHODS.DAEMON_LSP_SYNC, DaemonLspSyncResponseSchema],
      [RPC_METHODS.DAEMON_LSP_QUERY, DaemonLspQueryResponseSchema],
      [RPC_METHODS.DAEMON_LSP_WATCH, DaemonLspWatchResponseSchema],
      [RPC_METHODS.DAEMON_LSP_RESTART, DaemonLspRestartResponseSchema],
    ] as const) {
      const response = await handlers.get(method)!({ rootPath: '/workspace' });
      expect(schema.parse(response)).toMatchObject({ status: 'error', errorCode: 'filesystem_identity_custody_unavailable',
        details: { reason: 'requester_identity_unavailable' } });
    }
  });

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
          .toMatchObject({ ok: false, errorCode: 'invalid_request' });
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
      const f = await createInstalledFilesystemMachineFixture();
      const rootPath = join(f.directory, 'workspace');
      await mkdir(rootPath);
      await writeFile(join(rootPath, 'a.ts'), 'old');
      const credentials = f.bootstrap.credentials;
      const client = f.machine;
      const nativeEffect = {
        languageIntelligenceApply: client.createLanguageIntelligenceApplyActionExecutor(f.serverId),
      } satisfies Pick<ActionExecutorDeps, 'languageIntelligenceApply'>;
      const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
        'code.rename.apply': ['rpc'], 'code.file.rename.apply': ['rpc'], 'code.codeAction.apply': ['rpc'],
      } });
      const accountSettings = accountSettingsParse({ actionsSettingsV1: actionsSettings });
      const executor = createCliActionExecutorFromCredentials({ credentials, ...nativeEffect,
        readCredentials: async () => credentials,
        serverId: f.serverId, serverApiUrl: f.serverHttpBaseUrl,
        actionsSettingsProvider: { getActionsSettings: () => actionsSettings, getAccountSettings: () => accountSettings },
        machineActionDirectTargetTransport: { machineId: 'machine', invoke: client.invokeLocalMachineAction.bind(client) },
      });
      client.setRPCHandlers({ spawnSession: async () => ({ type: 'error', errorCode: 'SPAWN_FAILED', errorMessage: 'unused' }),
        stopSession: async () => true, requestShutdown: () => {} }, { externalActionIngressOwner: {
        currentServerId: f.serverId, executor, resolveTarget: async () => ({ kind: 'machine', machineId: 'machine' }),
      } });
      const invoke = (method: string, request: unknown) => f.invoke(method,
        createTargetedActionRpcRequestV1(request, { kind: 'machine', machineId: 'machine' }));
      const hash = (text: string) => createHash('sha256').update(text).digest('hex');
      const file = { path: 'a.ts', expectedHash: hash('old'), edits: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: 'next' },
      ] };
      try {
        expect(await invoke(RPC_METHODS.DAEMON_LSP_RENAME_APPLY, { rootPath, path: 'a.ts', operation: { kind: 'rename', files: [file] } }))
          .toMatchObject({ ok: true, results: [{ status: 'replaced' }] });
        expect(await readFile(join(rootPath, 'a.ts'), 'utf8')).toBe('next');
        expect(await invoke(RPC_METHODS.DAEMON_LSP_FILE_RENAME_APPLY, { rootPath, path: 'a.ts', operation: { kind: 'fileRename',
          files: [{ path: 'a.ts', expectedHash: hash('next'), edits: [], renameTo: 'moved.ts' }],
        } })).toMatchObject({ ok: true, results: [{ status: 'replaced', renameTo: 'moved.ts' }] });
        expect(await readFile(join(rootPath, 'moved.ts'), 'utf8')).toBe('next');
        expect(await invoke(RPC_METHODS.DAEMON_LSP_CODE_ACTION_APPLY, { rootPath, path: 'moved.ts', operation: { kind: 'codeAction',
          expectedHash: hash('old'), action: { serverId: 'fixture/server', title: 'Stale fix', hasCommand: false,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, files: [] },
        } })).toMatchObject({ ok: false, errorCode: 'stale_query' });
        expect(await readFile(join(rootPath, 'moved.ts'), 'utf8')).toBe('next');

        // The preview host obtains the real opaque code Action. Applying it
        // starts a new native server through the credentialed Action factory.
        await disposeLanguageServerHost();
        await writeFile(join(rootPath, 'b.ts'), 'old');
        const registry = createResolvedContributionRegistry({ languageServers: [{
          provenance: 'external', source: { kind: 'path' }, pluginId: 'fixture.language',
          identity: { pluginId: 'fixture.language', localId: 'language' }, manifestPath: join(rootPath, 'plugin.json'),
          definition: { id: 'language', title: 'Fixture language', languageIds: { typescript: 'typescript' },
            executable: { kind: 'systemTool', id: 'native' }, args: [] },
        }] });
        let holdApply = false;
        let actionHandle: PluginProtocolClientHandle<'jsonRpc'> | undefined;
        const nativeLog = join(rootPath, 'lsp-action.jsonl');
        const hostOptions = { readCurrentContributionRegistry: () => registry, async openProtocol(input) {
          const exec = createStablePluginExecService({ signal: input.signal, processOwner: input.processOwner,
            isOccurrenceCurrent: () => !input.signal.aborted,
            resolveExecutable: async () => ({ command: process.execPath, args: [resolve('src/lsp/__fixtures__/languageServer.cjs'),
              nativeLog, JSON.stringify({ semanticEdits: true,
                ...(holdApply ? { delayMethod: 'textDocument/codeAction' } : {}) })] }),
            resolvePath: async () => rootPath });
          actionHandle = await exec.clients.spawn({ kind: 'jsonRpc', framing: 'contentLength', cancellationMethod: '$/cancelRequest',
            launch: { executable: input.definition.executable, cwd: rootPath } });
          return actionHandle;
        } } satisfies LanguageServerHostOptions;
        const preview = createLanguageServerHost(hostOptions);
        let queried: Awaited<ReturnType<typeof preview.query>>;
        try {
          queried = await preview.query({ rootPath, path: 'moved.ts', kind: 'codeActions',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } });
        } finally { await preview.dispose(); }
        if (queried.status !== 'ok' || queried.kind !== 'codeActions' || !queried.actions[0]) throw new Error('Native code Action unavailable');
        await writeFile(nativeLog, '');
        holdApply = true;
        configureLanguageServerHost(hostOptions);
        const applying = invoke(RPC_METHODS.DAEMON_LSP_CODE_ACTION_APPLY, { rootPath, path: 'moved.ts', operation: {
          kind: 'codeAction', expectedHash: hash('next'), action: queried.actions[0],
        } });
        try {
          await vi.waitFor(async () => expect(await readFile(nativeLog, 'utf8')).toContain('textDocument/codeAction'));
          expect(readLanguageServerProcessRoots()).toContainEqual(expect.objectContaining({ requesterWorkAttributionV1: {
            serverId: f.homeServerIdentityId, accountId: 'requester', machineId: f.machineId,
            installationId: f.installation.installationId,
          } }));
        } finally {
          await actionHandle?.client.notify('fixture/release', { method: 'textDocument/codeAction' });
          await applying;
        }
        expect(await applying).toMatchObject({ ok: true, results: [{ path: 'b.ts', status: 'replaced' }] });
        expect(await readFile(join(rootPath, 'b.ts'), 'utf8')).toBe('fixed');
        expect(readLanguageServerProcessRoots()).toEqual([]);
      } finally { await disposeLanguageServerHost(); await client.shutdown(); }
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
    const f = await createInstalledFilesystemMachineFixture();
    const rootPath = f.directory;
    const session = new RpcHandlerManager({ scopePrefix: 'session-lsp-test', encryptionMode: 'plain' });
    const registration = registerSessionHandlers(session, rootPath, { sessionId: 'session-lsp-test' });
    try {
      const requests = [
        [RPC_METHODS.DAEMON_LSP_SYNC, { rootPath,
          op: { op: 'open', path: 'file.p7-no-server', languageId: 'p7-no-server', version: 0, text: '', unsaved: false } }],
        [RPC_METHODS.DAEMON_LSP_QUERY, { rootPath, path: 'file.p7-no-server', kind: 'documentSymbols' }],
        [RPC_METHODS.DAEMON_LSP_WATCH, { rootPath }],
        [RPC_METHODS.DAEMON_LSP_RESTART, { rootPath }],
      ] as const;
      const rpc = { invokeLocal: f.invoke };
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
      await f.machine.shutdown();
      await registration.dispose();
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
