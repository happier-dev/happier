import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { createActionExecutor } from './actionExecutor.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import type { ActionExecutorContext } from './executor/types.js';
import { FILESYSTEM_BROWSER_ACTION_IDS_V1 } from './filesystemActionIdsV1.js';

const mutations = [
  { id: 'daemon.filesystem.createDirectory', input: { rootPath: '/workspace', path: 'folder' }, method: 'createDirectory' },
  { id: 'daemon.filesystem.rename', input: { rootPath: '/workspace', from: 'a', to: 'b', overwrite: false }, method: 'renamePath' },
  { id: 'daemon.filesystem.delete', input: { rootPath: '/workspace', path: 'folder', recursive: false }, method: 'deletePath' },
  { id: 'daemon.filesystem.copy', input: { rootPath: '/workspace', from: 'a', to: 'b', overwrite: false, recursive: false }, method: 'copyPath' },
] as const;

describe('filesystem Action parity', () => {
  it('preserves a declared filename capability failure while keeping Action refusal terminal', async () => {
    const actionId = FILESYSTEM_BROWSER_ACTION_IDS_V1.listFiles;
    const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [actionId]: ['agent'] } }) };
    const nativeFailure = { ok: false, errorCode: 'ripgrep_unavailable' };
    const executor = createActionExecutor({ filesystemActionExecute: async () => nativeFailure });
    expect(await executor.execute(actionId, { rootPath: '/workspace' }, context))
      .toEqual({ ok: true, result: nativeFailure });
    const refused = createActionExecutor({ filesystemActionExecute: async () => ({ ok: false,
      errorCode: 'action_disabled', error: 'action_disabled' }) });
    expect(await refused.execute(actionId, { rootPath: '/workspace' }, context))
      .toMatchObject({ ok: false, errorCode: 'action_disabled' });
  });

  it('gives mounted command reads distinct child identities without bypassing their agent policy or configured Ask', async () => {
    const observed: Array<{ path: unknown; context: ActionExecutorContext }> = [];
    const executor = createActionExecutor({
      // Mounted client dispatch is the protocol's platform boundary. The child
      // still enters the real executor before the Machine transport below.
      uiCurrentContextAction: async ({ context }) => {
        const execute = context.executeOrdinaryChildAction;
        if (!execute) return { ok: false, errorCode: 'unsupported_action', error: 'missing ordinary child executor' };
        for (const path of ['/workspace', '/workspace/src']) {
          const result = await execute(FILESYSTEM_BROWSER_ACTION_IDS_V1.browseDirectory, { path }, {
            signal: context.signal, externalActionTarget: { kind: 'machine', machineId: 'machine' },
            serverId: 'addressed-home', expectedAccountId: 'account',
          });
          if (!result.ok) return result;
        }
        return { ok: true, result: null };
      },
      filesystemActionExecute: async ({ input, context }) => {
        const path = (input as { path: string }).path;
        observed.push({ path, context });
        return { ok: true, path, entries: [], truncated: false };
      },
    });
    const controller = new AbortController();
    const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation',
      runtimeAccountId: 'account', actionRequestId: 'mounted-parent', signal: controller.signal,
      actionCaller: { kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0 } };
    const parent = 'ui.current_context.command.invoke';
    const child = FILESYSTEM_BROWSER_ACTION_IDS_V1.browseDirectory;
    const settings = (childPolicy: 'allow' | 'disabled' | 'ask') => ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { [parent]: ['agent'], ...(childPolicy === 'allow' ? { [child]: ['agent'] } : {}) },
      ...(childPolicy === 'disabled' ? { actions: { [child]: { disabledSurfaces: ['agent'] } } } : {}),
      ...(childPolicy === 'ask' ? { actions: { [child]: { approvalRequiredSurfaces: ['agent'] } } } : {}),
    });
    const allowed = await executor.execute(parent, { commandId: 'mounted-command' }, { ...context, actionsSettings: settings('allow') });
    expect(allowed, JSON.stringify(allowed)).toMatchObject({ ok: true });
    expect(observed.map(row => row.path)).toEqual(['/workspace', '/workspace/src']);
    expect(new Set(observed.map(row => row.context.actionRequestId)).size).toBe(2);
    for (const row of observed) {
      expect(row.context.actionRequestId).not.toBe(context.actionRequestId);
      expect(row.context).toMatchObject({ surface: 'agent', authority: 'account_automation', serverId: 'addressed-home',
        runtimeAccountId: 'account', expectedAccountId: 'account', actionCaller: context.actionCaller,
        externalActionTarget: { kind: 'machine', machineId: 'machine' } });
      expect(row.context.signal).toBe(controller.signal);
    }
    observed.length = 0;
    expect(await executor.execute(parent, { commandId: 'mounted-command' }, { ...context, actionsSettings: settings('disabled') }))
      .toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(observed).toHaveLength(0);
    const asking = await executor.execute(parent, { commandId: 'mounted-command' }, { ...context, actionsSettings: settings('ask') });
    expect(asking).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(observed).toHaveLength(0);
    const continued = await executor.executeAdmittedClientAction(parent, { commandId: 'mounted-command' }, {
      ...context, actionsSettings: settings('ask'), bypassApprovals: true,
    });
    expect(continued, JSON.stringify(continued)).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(observed).toHaveLength(0);
  });

  it('admits browser roots, directory and filename reads through the filesystem owner with original caller policy', async () => {
    const reads = [
      { id: 'daemon.filesystem.listRoots', input: {}, output: { ok: true, roots: [{ id: 'workspace', label: 'Workspace', path: '/workspace' }] } },
      { id: 'daemon.filesystem.browseDirectory', input: { path: '/workspace', includeFiles: true }, output: { ok: true, path: '/workspace', entries: [], truncated: false } },
      { id: 'daemon.filesystem.listFiles', input: { rootPath: '/workspace', query: 'target' }, output: { ok: true, paths: ['src/target.ts'], truncated: false } },
    ];
    const observed: ActionExecutorContext[] = [];
    for (const read of reads) {
      const actionId = ActionIdSchema.parse(read.id);
      // The machine transport is the boundary; admission, policy and output
      // validation remain the real shared executor and published schemas.
      const executor = createActionExecutor({ filesystemActionExecute: async ({ context }) => {
        observed.push(context); return read.output;
      } });
      const controller = new AbortController();
      const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation',
        serverId: 'home', runtimeAccountId: 'account', expectedAccountId: 'account', actionRequestId: 'browser-read',
        actionCaller: { kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0 },
        externalActionTarget: { kind: 'machine', machineId: 'machine' }, signal: controller.signal };
      const before = observed.length;
      expect(await executor.execute(actionId, read.input, { ...context,
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { disabledSurfaces: ['agent'] } } }) }))
        .toMatchObject({ ok: false, errorCode: 'action_disabled' });
      expect(observed).toHaveLength(before);
      const result = await executor.execute(actionId, read.input, { ...context,
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [actionId]: ['agent'] } }) });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: read.output });
      expect(observed.at(-1)).toMatchObject({ surface: 'agent', authority: 'account_automation',
        runtimeAccountId: 'account', expectedAccountId: 'account', serverId: 'home', actionRequestId: 'browser-read',
        externalActionTarget: context.externalActionTarget, actionCaller: context.actionCaller, signal: controller.signal });
      expect(observed.at(-1)?.signal).toBe(controller.signal);
    }
  });

  it('exposes bounded file reads, writes and directory reads through the same strict filesystem family', () => {
    const cases = [
      { id: 'daemon.filesystem.readFile', input: { rootPath: '/workspace', path: '/workspace/file.bin' }, safety: 'safe' },
      { id: 'daemon.filesystem.writeFile', input: { rootPath: '/workspace', path: '/workspace/file.bin', content: 'AAE=', expectedHash: null }, safety: 'danger' },
      { id: 'daemon.filesystem.listDirectory', input: { rootPath: '/workspace', path: '/workspace/src', includeGitIgnore: true }, safety: 'safe' },
      { id: 'daemon.filesystem.getDirectoryTree', input: { rootPath: '/workspace', path: '/workspace/src', maxDepth: 2 }, safety: 'safe' },
    ] as const;
    for (const row of cases) {
      const spec = getActionSpec(ActionIdSchema.parse(row.id));
      expect(spec.inputSchema.parse(row.input)).toEqual(row.input);
      expect(spec.inputSchema.safeParse({ ...row.input, callerAccountId: 'forged' }).success).toBe(false);
      expect(spec.executionPlacement).toBe('machine');
      expect(spec.surfaces).toMatchObject({ ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true });
      expect(spec.bindings?.mcpToolName).toBeTruthy();
      expect(spec.bindings?.voiceClientToolName).toBeTruthy();
      expect(spec.safety).toBe(row.safety);
    }
  });

  it('exposes qualified strict filesystem mutations through the machine owner with Ask first', () => {
    for (const { id, input, method } of mutations) {
      const spec = getActionSpec(ActionIdSchema.parse(id));
      expect(spec.inputSchema.parse(input)).toEqual(input);
      expect(spec.inputSchema.safeParse({ ...input, unrelatedAuthority: 'allow' }).success).toBe(false);
      const { rootPath: _root, ...unqualified } = input;
      expect(spec.inputSchema.safeParse(unqualified).success).toBe(false);
      expect(spec.bindings?.rpcMethod).toBe(id);
      expect(spec.bindings?.rpcMethodAliases).toContain(method);
      expect(spec.bindings?.mcpToolName).toBeTruthy();
      expect(spec.bindings?.voiceClientToolName).toBeTruthy();
      expect(spec.executionPlacement).toBe('machine');
      expect(spec.surfaces).toMatchObject({ ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true });
      expect(resolveActionApprovalRouting({ actionId: spec.id, spec, context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(true);
      expect(spec.outputSchema.safeParse({ success: false, error: 'Destination already exists' }).success).toBe(true);
      expect(spec.outputSchema.safeParse({ success: true, invented: true }).success).toBe(false);
    }
  });

  it('requires an explicit choice for overwrite and recursive effects', () => {
    for (const { id, input } of mutations.slice(1)) {
      const spec = getActionSpec(ActionIdSchema.parse(id));
      const record: Record<string, unknown> = { ...input };
      delete record.overwrite;
      delete record.recursive;
      expect(spec.inputSchema.safeParse(record).success).toBe(false);
    }
  });

  it('admits qualified cross-target byte custody without treating source identity as an OS path', () => {
    const spec = getActionSpec('daemon.filesystem.copy');
    const input = { kind: 'prepared_transfer', source: { kind: 'file', serverId: 'source-home', machineId: 'source-machine',
      rootPath: '/source', path: 'literal\nname ', sourceId: 'admitted-source', sizeBytes: 4, sha256: 'a'.repeat(64) },
      destination: { serverId: 'destination-home', machineId: 'destination-machine', rootPath: '/destination', path: 'copy' },
      overwrite: false, recursive: false };
    expect(spec.inputSchema.parse(input)).toEqual(input);
    const targetCopy = { ...input, kind: 'target_copy', source: { serverId: 'source-home', machineId: 'source-machine',
      rootPath: '/source', path: 'literal\nname ' } };
    expect(spec.inputSchema.parse(targetCopy)).toEqual(targetCopy);
    expect(spec.inputSchema.safeParse({ ...targetCopy, source: { ...targetCopy.source, sourceId: '/privileged' } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, localSourcePath: '/privileged' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, destination: { ...input.destination, requesterAccountId: 'invented' } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, source: { ...input.source, kind: 'directory' } }).success).toBe(false);
    const entryTree = { operationId: 'entry-operation', expectation: { kind: 'directory', fingerprint: 'b'.repeat(64) },
      blobs: [{ transferId: 'entry-operation:blob', sizeBytes: 4, manifestHash: `sha256:${'c'.repeat(64)}` }] };
    expect(spec.inputSchema.parse({ ...input, recursive: true, source: { ...input.source, kind: 'entry_tree', entryTree } }))
      .toMatchObject({ source: { kind: 'entry_tree', entryTree } });
    expect(spec.inputSchema.safeParse({ ...input, source: { ...input.source, kind: 'entry_tree', entryTree: { ...entryTree, rootPath: '/invented' } } }).success).toBe(false);
    expect(spec.operation).toMatchObject({ version: 1, visibility: 'activity' });
    expect(resolveActionApprovalRouting({ actionId: spec.id, spec, input,
      context: { surface: 'cli', authority: 'account_automation' } }))
      .toMatchObject({ required: true, flow: 'blocking', result: 'required' });
  });

  it('declares full prepared transfers as tracked machine operations with strict source and destination identity', () => {
    const transfers = [
      { id: 'daemon.filesystem.upload', input: { rootPath: '/workspace', path: 'binary', source: { sourceId: 'source', sizeBytes: 4 }, overwrite: false } },
      { id: 'daemon.filesystem.download', input: { rootPath: '/workspace', path: 'binary', destination: { destinationId: 'destination' }, asZip: false } },
    ] as const;
    for (const { id, input } of transfers) {
      const spec = getActionSpec(ActionIdSchema.parse(id));
      expect(spec.inputSchema.parse(input)).toEqual(input);
      expect(spec.inputSchema.safeParse({ ...input, requesterAccountId: 'untrusted' }).success).toBe(false);
      expect(spec.executionPlacement).toBe('machine');
      expect(spec.operation).toMatchObject({ version: 1, visibility: 'activity' });
      // Admission cannot hand custody to durable replay: the invoking byte
      // driver must remain mounted until the approval decision arrives.
      expect(resolveActionApprovalRouting({ actionId: spec.id, spec, input,
        context: { surface: 'cli', authority: 'account_automation' } }))
        .toMatchObject({ required: true, flow: 'blocking', result: 'required' });
      expect(spec.outputSchema.safeParse({ success: true }).success).toBe(false);
    }
    const cancel = getActionSpec(ActionIdSchema.parse('daemon.filesystem.transfer.cancel'));
    expect(cancel.bindings?.mcpToolName).toBeTruthy();
    expect(cancel.bindings?.voiceClientToolName).toBeTruthy();
    expect(cancel.inputSchema.parse({ rootPath: '/workspace', direction: 'upload', transferId: 'transfer' })).toEqual({ rootPath: '/workspace', direction: 'upload', transferId: 'transfer' });
    expect(cancel.inputSchema.safeParse({ direction: 'upload', transferId: 'transfer' }).success).toBe(false);
    expect(getActionSpec('daemon.filesystem.download').inputSchema.safeParse({ rootPath: '/workspace', path: 'file',
      destination: { destinationId: 'destination' }, asZip: false, confinedToWorkingDirectory: false }).success).toBe(false);
    expect(getActionSpec('daemon.filesystem.download').inputSchema.parse({ rootPath: '/workspace', path: 'directory',
      destination: { destinationId: 'destination' }, asZip: false, format: 'entry_tree' }))
      .toMatchObject({ format: 'entry_tree' });
    expect(getActionSpec('daemon.filesystem.download').inputSchema.safeParse({ rootPath: '/workspace', path: 'directory',
      destination: { destinationId: 'destination' }, asZip: true, format: 'entry_tree' }).success).toBe(false);
  });
});
