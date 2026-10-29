import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { isPluginSurfaceExcludedActionId } from './pluginActionSurface.js';
import { resolveApprovalRequestApproveAdmission } from './actionApprovalPresentation.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { DaemonWorkspaceFileSearchRequestSchema, DaemonWorkspaceFileSearchResponseSchema } from '../machines/workspaceFiles.js';
import { bindContextualActionToolInput } from './actionToolContext.js';
import { DaemonLspApplyRequestSchema, DaemonLspQueryRequestSchema } from '../machines/languageIntelligence.js';

describe('search-backed code Actions', () => {
  it('binds the new editing intelligence reads to the session and preserves query operands', async () => {
    const requests: unknown[] = [];
    const executor = createActionExecutor({ languageIntelligenceQuery: async args => {
      requests.push({ ...args, request: DaemonLspQueryRequestSchema.parse(args.request) }); return { status: 'loading' };
    } });
    const context = { surface: 'agent' as const, serverId: 'home', defaultSessionId: 'session', defaultSessionMachineId: 'machine',
      defaultSessionRootPath: '/repo' };
    const cases = [
      { id: 'code.completion.list', input: { line: 3, character: 2 }, query: { kind: 'completion', position: { line: 2, character: 2 } } },
      { id: 'code.signature.get', input: { line: 3, symbol: 'call' }, query: { kind: 'signatureHelp', position: { line: 2, symbol: 'call' } } },
      { id: 'code.typeDefinition.get', input: { line: 3, symbol: 'value' }, query: { kind: 'typeDefinition', position: { line: 2, symbol: 'value' } } },
      { id: 'code.implementation.get', input: { line: 3, symbol: 'value' }, query: { kind: 'implementation', position: { line: 2, symbol: 'value' } } },
      { id: 'code.symbols.workspace', input: { query: 'Widget' }, query: { kind: 'workspaceSymbol', query: 'Widget' } },
      { id: 'code.callHierarchy.get', input: { line: 3, symbol: 'call', hierarchy: { direction: 'prepare' } },
        query: { kind: 'callHierarchy', position: { line: 2, symbol: 'call' }, hierarchy: { direction: 'prepare' } } },
      { id: 'code.callHierarchy.get', input: { line: 3, symbol: 'call', hierarchy: { direction: 'incoming' } },
        query: { kind: 'callHierarchy', position: { line: 2, symbol: 'call' }, hierarchy: { direction: 'incoming' } } },
      { id: 'code.callHierarchy.get', input: { line: 3, character: 0, hierarchy: { direction: 'outgoing' } },
        query: { kind: 'callHierarchy', position: { line: 2, character: 0 }, hierarchy: { direction: 'outgoing' } } },
      { id: 'code.callHierarchy.get', input: { hierarchy: { direction: 'incoming', itemId: 'call-item' }, serverId: 'fixture/server' },
        query: { kind: 'callHierarchy', hierarchy: { direction: 'incoming', itemId: 'call-item' }, serverId: 'fixture/server' } },
      { id: 'code.diagnostics.list', input: { scope: 'project' }, query: { kind: 'diagnostics', scope: 'project' } },
    ] as const;
    for (const item of cases) {
      const id = ActionIdSchema.parse(item.id);
      const input = bindContextualActionToolInput({ actionId: id, input: { path: 'a.ts', ...item.input }, context });
      expect(await executor.execute(id, input, context)).toEqual({ ok: true, result: { status: 'loading' } });
      expect(requests.at(-1)).toEqual({ machineId: 'machine', request: { rootPath: '/repo', path: 'a.ts', text: 'disk', ...item.query } });
      expect(isApprovalRequiredByActionsSettings(id, { v: 1, actions: {} }, context)).toBe(false);
    }
    expect(requests).toHaveLength(cases.length);
  });

  it('previews format/import edits without writes and applies only the reviewed guarded files', async () => {
    const requests: unknown[] = [];
    const executor = createActionExecutor({
      languageIntelligenceQuery: async args => { requests.push({ ...args, request: DaemonLspQueryRequestSchema.parse(args.request) }); return { status: 'loading' }; },
      languageIntelligenceApply: async args => { requests.push({ ...args, request: DaemonLspApplyRequestSchema.parse(args.request) }); return { ok: true, results: [] }; },
    });
    const target = { machineId: 'machine', rootPath: '/repo', path: 'a.ts' };
    const files = [{ path: 'a.ts', expectedHash: 'a'.repeat(64), edits: [] }];
    const range = { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } };
    const formattingOptions = { tabSize: 4, insertSpaces: true };
    const approvals: unknown[] = [];
    const admittedExecutor = createActionExecutor({
      languageIntelligenceQuery: async () => ({ status: 'loading' }),
      languageIntelligenceApply: async () => { throw new Error('Rejected edits must never reach the Machine'); },
      approvalsCreate: async ({ request }) => { approvals.push(request); return { artifactId: 'edit-approval' }; },
      approvalsUpdate: async () => ({ ok: true }),
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject', request }),
      isActionApprovalRequired: (id, context, input) => isApprovalRequiredByActionsSettings(id, { v: 1, actions: {} }, context, undefined, undefined, input),
    });
    for (const name of ['code.format.apply', 'code.imports.organize'] as const) {
      const id = ActionIdSchema.parse(name);
      const kind = name === 'code.format.apply' ? 'format' : 'organizeImports';
      expect(await executor.execute(id, { ...target, operation: { kind: 'preview',
        ...(kind === 'format' ? { range, formattingOptions } : {}) } }, { surface: 'ui', authority: 'present_user' }))
        .toEqual({ ok: true, result: { status: 'loading' } });
      expect(requests.at(-1)).toEqual({ machineId: 'machine', request: { rootPath: '/repo', path: 'a.ts', text: 'disk',
        kind: kind === 'format' ? 'rangeFormatting' : 'organizeImports', ...(kind === 'format' ? { range, formattingOptions } : {}) } });
      expect(await executor.execute(id, { ...target, operation: { kind: 'apply', files } }, { surface: 'ui', authority: 'present_user' }))
        .toEqual({ ok: true, result: { ok: true, results: [] } });
      expect(requests.at(-1)).toEqual({ machineId: 'machine', actionId: id, request: { rootPath: '/repo', path: 'a.ts', operation: { kind, files } } });
      expect(isApprovalRequiredByActionsSettings(id, { v: 1, actions: {} }, { surface: 'agent' })).toBe(true);
      expect(isApprovalRequiredByActionsSettings(id, { v: 1, actions: {} }, { surface: 'ui', authority: 'present_user' })).toBe(false);
      const context = { surface: 'agent', authority: 'account_automation', actionRequestId: `review-${id}`,
        serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' } } as const;
      expect(await admittedExecutor.execute(id, { ...target, operation: { kind: 'preview' } }, context))
        .toEqual({ ok: true, result: { status: 'loading' } });
      const input = { ...target, operation: { kind: 'apply', files } };
      expect(await admittedExecutor.execute(id, input, context)).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
      expect(approvals.at(-1)).toMatchObject({ actionId: id, actionArgs: input });
    }
    expect(requests).toHaveLength(4);
    expect(approvals).toHaveLength(2);
  });
  it('resolves a session code query through the shared tool-scope owner before Action dispatch', async () => {
    const requests: unknown[] = [];
    const executor = createActionExecutor({ languageIntelligenceQuery: async args => {
      requests.push(args);
      return { status: 'loading' };
    } });
    const context = { surface: 'agent' as const, defaultSessionId: 'session', defaultSessionMachineId: 'session-machine',
      defaultSessionRootPath: '/session/repo' };
    const input = bindContextualActionToolInput({ actionId: 'code.definition.get', input: { path: 'example.ts', line: 1, symbol: 'example' }, context });
    expect(await executor.execute('code.definition.get', input, context)).toEqual({ ok: true, result: { status: 'loading' } });
    expect(requests).toEqual([{ machineId: 'session-machine', request: { rootPath: '/session/repo', path: 'example.ts',
      kind: 'definition', text: 'disk', position: { line: 0, symbol: 'example' } } }]);
  });
  it('presents real semantic approvals using fields from each operation rather than positional-query operands', async () => {
    const target = { machineId: 'machine', rootPath: '/repo', path: 'a.ts' };
    const files = [{ path: 'a.ts', expectedHash: 'a'.repeat(64), edits: [] }];
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    const cases = [
      { id: 'code.rename.apply', input: { ...target, files }, field: 'files' },
      { id: 'code.file.rename.apply', input: { ...target, files: [{ ...files[0], renameTo: 'b.ts' }] }, field: 'files' },
      { id: 'code.codeAction.apply', input: { ...target, operation: { kind: 'codeAction', expectedHash: 'a'.repeat(64),
        action: { serverId: 'fixture/server', title: 'Fix', range, files, hasCommand: false } } }, field: 'operation' },
      { id: 'code.file.rename.preview', input: { ...target, newPath: 'b.ts' }, field: 'newPath' },
      { id: 'code.rename.preview', input: { ...target, line: 1, symbol: 'old', newName: 'next' }, field: 'line' },
    ] as const;
    for (const item of cases) {
      let request: ApprovalRequest | undefined;
      const executor = createActionExecutor({
        approvalsCreate: async ({ request: value }) => { request = value; return { artifactId: 'approval' }; },
        isActionApprovalRequired: (id, context, input) => isApprovalRequiredByActionsSettings(id,
          { v: 1, actions: { [item.id]: { approvalRequiredSurfaces: ['ui'] } } }, context, undefined, undefined, input),
      });
      await executor.execute(item.id, item.input, { surface: 'ui', authority: 'present_user', actionRequestId: 'review-request',
        serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' } });
      if (!request) throw new Error(`Expected actual approval for ${item.id}`);
      const admission = resolveApprovalRequestApproveAdmission(request);
      expect(admission, item.id).toMatchObject({ status: 'available' });
      expect(admission.presentation.rows, item.id).toEqual(expect.arrayContaining([expect.objectContaining({ path: item.field })]));
    }
  });

  it('keeps reviewed semantic writes behind real agent approval', async () => {
    const requests: unknown[] = [];
    let applied = false;
    const executor = createActionExecutor({
      languageIntelligenceApply: async () => { applied = true; return { ok: true, results: [] }; },
      approvalsCreate: async ({ request }) => { requests.push(request); return { artifactId: 'rename-approval' }; },
      approvalsUpdate: async () => ({ ok: true }),
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject', request }),
      isActionApprovalRequired: (id, context, input) => isApprovalRequiredByActionsSettings(id, { v: 1, actions: {} }, context, undefined, undefined, input),
    });
    const input = { machineId: 'machine', rootPath: '/repo', path: 'a.ts', files: [{ path: 'a.ts', expectedHash: 'a'.repeat(64), edits: [] }] };
    expect(await executor.execute('code.rename.apply', input, { surface: 'agent', authority: 'account_automation',
      actionRequestId: 'rename-request', serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' },
    })).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    expect(requests).toMatchObject([{ actionId: 'code.rename.apply', actionArgs: input }]);
    expect(applied).toBe(false);
  });
  it('retains the Machine-side durable approval receipt for a semantic edit without parsing it as completed writes', async () => {
    const pending = { kind: 'approval_request_created', artifactId: 'rename-approval', actionId: 'code.rename.apply' } as const;
    const executor = createActionExecutor({ languageIntelligenceApply: async () => pending });
    const input = { machineId: 'machine', rootPath: '/repo', path: 'a.ts',
      files: [{ path: 'a.ts', expectedHash: 'a'.repeat(64), edits: [] }] };
    expect(await executor.execute('code.rename.apply', input, { surface: 'ui', authority: 'present_user' }))
      .toEqual({ ok: true, result: pending });
  });
  it('exposes semantic previews safely and routes reviewed edits through the mutation Action dependency', async () => {
    const preview = ActionIdSchema.parse('code.rename.preview');
    const apply = ActionIdSchema.parse('code.rename.apply');
    const files = [{ path: 'a.ts', expectedHash: 'a'.repeat(64), edits: [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: 'next',
    }] }];
    const requests: unknown[] = [];
    const executor = createActionExecutor({
      languageIntelligenceQuery: async (args: unknown) => { requests.push(args); return { status: 'ok', kind: 'rename', fileHash: 'a'.repeat(64), files }; },
      languageIntelligenceApply: async (args: unknown) => { requests.push(args); return { ok: true, results: [{ path: 'a.ts', status: 'replaced', hash: 'b'.repeat(64), edits: [] }] }; },
    } as unknown as ActionExecutorDeps);
    expect(await executor.execute(preview, { machineId: 'machine', rootPath: '/repo', path: 'a.ts', line: 1, symbol: 'old', newName: 'next' }, { surface: 'agent' }))
      .toMatchObject({ ok: true, result: { status: 'ok', files } });
    expect(await executor.execute(apply, { machineId: 'machine', rootPath: '/repo', path: 'a.ts', files }, { surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ ok: true, result: { results: [{ status: 'replaced' }] } });
    expect(requests).toMatchObject([
      { request: { kind: 'rename', position: { line: 0, symbol: 'old' }, text: 'disk', newName: 'next' } },
      { actionId: apply, request: { operation: { kind: 'rename', files } } },
    ]);
    for (const id of ['code.rename.apply', 'code.file.rename.apply', 'code.codeAction.apply'] as const) {
      expect(isApprovalRequiredByActionsSettings(id, { v: 1, actions: {} }, { surface: 'agent' })).toBe(true);
      expect(isApprovalRequiredByActionsSettings(id, { v: 1, actions: {} }, { surface: 'ui', authority: 'present_user' })).toBe(false);
    }
  });
  it('queries disk text by one-based line and preserves typed semantic outcomes', async () => {
    const id = ActionIdSchema.parse('code.hover.get');
    const requests: unknown[] = [];
    const fileHash = 'a'.repeat(64);
    let response: unknown = { status: 'ok', kind: 'hover', fileHash,
      sections: [{ serverId: 'test.language', label: 'Language', markdown: 'type Name' }] };
    const executor = createActionExecutor({ languageIntelligenceQuery: async (args: unknown) => {
      requests.push(args); return response;
    } } as unknown as ActionExecutorDeps);
    const input = { machineId: 'machine', rootPath: '/repo', path: 'a.ts', line: 4, symbol: 'Name', occurrence: 2 };
    expect(await executor.execute(id, input, { surface: 'agent' })).toMatchObject({ ok: true, result: { status: 'ok', fileHash } });
    expect(requests).toEqual([{ machineId: 'machine', request: { rootPath: '/repo', path: 'a.ts', kind: 'hover',
      position: { line: 3, symbol: 'Name', occurrence: 2 }, text: 'disk' } }]);
    for (const outcome of [{ status: 'loading' }, { status: 'unavailable', reason: 'server_missing' },
      { status: 'error', errorCode: 'unsaved_editor_changes', diskHash: fileHash },
      { status: 'error', errorCode: 'symbol_not_found', candidates: ['Other'] }]) {
      response = outcome;
      expect(await executor.execute(id, input, { surface: 'mcp' })).toEqual({ ok: true, result: outcome });
    }
  });

  it('searches declarations through the real executor and strict workspace search contract', async () => {
    const id = ActionIdSchema.parse('code.definition.get');
    const requests: unknown[] = [];
    // The remote Machine search is the system boundary; Action admission and query projection are real.
    const executor = createActionExecutor({ languageIntelligenceQuery: async () => ({ status: 'unavailable', reason: 'no_capable_server' }), workspaceFilesSearch: async ({ machineId, ...request }) => {
      expect(machineId).toBe('machine');
      requests.push(DaemonWorkspaceFileSearchRequestSchema.parse(request));
      const candidates = ['other/far.ts', 'src/near.ts', 'src/current.ts'].map(path => ({ path, matches: [
        { line: 4, column16: 8, length16: 14, text: 'export function greet() {}', before: [], after: [] },
      ] }));
      return DaemonWorkspaceFileSearchResponseSchema.parse({ ok: true, files: candidates, hasMore: true, coverage: 'partial' });
    } } satisfies Pick<ActionExecutorDeps, 'workspaceFilesSearch' | 'languageIntelligenceQuery'> as unknown as ActionExecutorDeps);
    const result = await executor.execute(id, { machineId: 'machine', rootPath: '/repo', path: 'src/current.ts', line: 8,
      symbol: 'greet', languageId: 'typescript' }, { surface: 'agent' });
    expect(result).toMatchObject({ ok: true, result: { status: 'ok', source: 'text_matches', hasMore: true, coverage: 'partial',
      locations: [ { path: 'src/current.ts', range: { start: { line: 3, character: 16 }, end: { line: 3, character: 21 } } },
        { path: 'src/near.ts' }, { path: 'other/far.ts' } ] } });
    expect(requests).toMatchObject([{ rootPath: '/repo', regex: true, matchCase: true, query: expect.stringContaining('greet') }]);
    if (!result.ok) throw new Error('Action failed');
    expect(getActionSpec(id).outputSchema!.parse(result.result)).toEqual(result.result);
  });

  it('preserves unavailable search and rejects a missing symbol instead of guessing a column', async () => {
    const id = ActionIdSchema.parse('code.references.list');
    const executor = createActionExecutor({ languageIntelligenceQuery: async () => ({ status: 'unavailable', reason: 'no_capable_server' }), workspaceFilesSearch: async () => ({ ok: false, code: 'root_not_found' }) } as unknown as ActionExecutorDeps);
    const input = { machineId: 'machine', rootPath: '/repo', path: 'a.ts', line: 1, symbol: 'name' };
    await expect(executor.execute(id, input, { surface: 'mcp' })).resolves.toMatchObject({ ok: true,
      result: { status: 'unavailable', reason: 'root_not_found' } });
    expect(getActionSpec(id).inputSchema.safeParse({ ...input, symbol: undefined, character: 0 }).success).toBe(true);
    expect(await executor.execute(id, { ...input, symbol: undefined }, { surface: 'agent' }))
      .toEqual({ ok: true, result: { status: 'error', errorCode: 'invalid_position' } });
    expect(await executor.execute(id, { ...input, symbol: undefined, character: 0 }, { surface: 'agent' }))
      .toEqual({ ok: true, result: { status: 'unavailable', reason: 'no_capable_server' } });
  });

  it('keeps both safe reads available to plugins and honors explicit approval settings', () => {
    for (const rawId of ['code.hover.get', 'code.definition.get', 'code.references.list', 'code.symbols.list', 'code.diagnostics.list', 'code.restart',
      'code.completion.list', 'code.signature.get', 'code.typeDefinition.get', 'code.implementation.get', 'code.symbols.workspace', 'code.callHierarchy.get']) {
      const id = ActionIdSchema.parse(rawId);
      const spec = getActionSpec(id);
      expect(spec).toMatchObject({ sideEffectClass: id === 'code.restart' ? 'write' : 'read', safety: 'safe', approval: { result: 'required' }, executionPlacement: 'machine' });
      expect(isPluginSurfaceExcludedActionId(id)).toBe(false);
      expect(spec.pluginCallerPolicy).toBeUndefined();
      for (const surface of ['ui', 'agent', 'mcp', 'cli', 'plugin'] as const) {
        expect(isApprovalRequiredByActionsSettings(id, { v: 1, actions: {} }, { surface })).toBe(false);
      }
      expect(isApprovalRequiredByActionsSettings(id, { v: 1, actions: { [id]: { approvalRequiredSurfaces: ['agent'] } } }, { surface: 'agent' })).toBe(true);
    }
  });

  it('keeps the language-server selector distinct from the Home and validates semantic hashes', async () => {
    const requests: unknown[] = [];
    const executor = createActionExecutor({
      languageIntelligenceRestart: async (args: unknown, context: unknown) => { requests.push({ args, context }); return { status: 'ok' }; },
      languageIntelligenceQuery: async () => ({ status: 'ok', kind: 'hover', sections: [] }),
    } as unknown as ActionExecutorDeps);
    expect(await executor.execute('code.restart', { machineId: 'machine', rootPath: '/repo', serverId: 'language.definition' },
      { surface: 'ui', authority: 'present_user', serverId: 'home' })).toEqual({ ok: true, result: { status: 'ok' } });
    expect(requests).toMatchObject([{ args: { machineId: 'machine', request: { rootPath: '/repo', serverId: 'language.definition' } }, context: { serverId: 'home' } }]);
    expect(await executor.execute('code.hover.get', { machineId: 'machine', rootPath: '/repo', path: 'a.ts', line: 1, character: 0 },
      { surface: 'agent' })).toMatchObject({ ok: false, errorCode: 'invalid_response' });
  });
});
