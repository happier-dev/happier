import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { WORKSPACE_ACTION_INPUT_SCHEMAS, WORKSPACE_ACTION_OUTPUT_SCHEMAS, WORKSPACE_ACTION_SPECS, isSafeWorkspaceFilePath } from './workspaceActionFamily.js';
import { getActionSpec } from './actionSpecs.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';

describe('workspace client actions', () => {
  it('opens typed SCM resources through one closed resource arm and rejects ambiguous addresses', () => {
    const open = WORKSPACE_ACTION_INPUT_SCHEMAS['workspace.tabs.open'];
    const resource = { kind: 'pullRequest', url: 'https://github.com/acme/repo/pull/42' };
    expect(open.parse({ resource })).toEqual({ resource });
    expect(open.safeParse({ resource, href: '/plugins/triage' }).success).toBe(false);
    expect(open.safeParse({ resource, file: { target: { kind: 'session', sessionId: 's' }, path: 'a.ts' } }).success).toBe(false);
    expect(open.safeParse({ resource: { ...resource, kind: 'unknown' } }).success).toBe(false);
    expect(open.safeParse({ resource: { ...resource, url: 'file:///etc/passwd' } }).success).toBe(false);
    expect(open.safeParse({ resource: { ...resource, accountId: 'foreign' } }).success).toBe(false);
    expect(open.safeParse({ resource, mode: 'splitRight' }).success).toBe(false);
    expect(open.safeParse({ resource, tabId: 'replace' }).success).toBe(false);
  });

  it('activates an empty full window without pretending it is a tab or permitting window close through tab close', () => {
    const activate = WORKSPACE_ACTION_INPUT_SCHEMAS['workspace.tabs.activate'];
    expect(activate.safeParse({ windowId: 'full-b' }).success).toBe(true);
    expect(activate.safeParse({ windowId: 'full-b', tabId: 'tab' }).success).toBe(false);
    expect(activate.safeParse({ windowId: 'full-b', address: {
      kind: 'workspaceTab', serverId: 'home', accountId: 'account', layoutId: 'full-b', tabId: 'tab',
    } }).success).toBe(false);
    expect(WORKSPACE_ACTION_INPUT_SCHEMAS['workspace.tabs.close'].safeParse({ windowId: 'full-b' }).success).toBe(false);
  });
  it('addresses workspace and pane tabs by their owning layout while preserving legacy tab ids', () => {
    const pane = { kind: 'paneTab', serverId: 'home-a', accountId: 'account-a', layoutId: 'main', scopeId: 'session:s', tabKey: 'file:a' };
    const workspace = { kind: 'workspaceTab', serverId: 'home-a', accountId: 'account-a', layoutId: 'main', tabId: 'tab-a' };
    for (const action of ['workspace.tabs.activate', 'workspace.tabs.close', 'workspace.tabs.move'] as const) {
      const extra = action === 'workspace.tabs.move' ? { targetGroupId: 'details' } : {};
      const schema = WORKSPACE_ACTION_INPUT_SCHEMAS[action];
      expect(schema.safeParse({ address: pane, ...extra }).success).toBe(true);
      expect(schema.safeParse({ address: workspace, ...extra }).success).toBe(true);
      expect(schema.safeParse({ tabId: 'legacy', ...extra }).success).toBe(true);
      expect(schema.safeParse({ address: pane, tabId: 'ambiguous', ...extra }).success).toBe(false);
      expect(schema.safeParse({ address: { ...pane, layoutId: undefined }, ...extra }).success).toBe(false);
    }
  });
  it('routes qualified tab mutations through the Home named by the address', () => {
    for (const action of ['workspace.tabs.activate', 'workspace.tabs.close', 'workspace.tabs.move'] as const) {
      const spec = getActionSpec(action);
      const extra = action === 'workspace.tabs.move' ? { targetGroupId: 'details' } : {};
      expect(spec.invocationServerIdForInput?.({ address: {
        kind: 'paneTab', serverId: 'home-b', accountId: 'account-b', layoutId: 'main', scopeId: 'session:s', tabKey: 'file:a',
      }, ...extra })).toBe('home-b');
      expect(spec.invocationServerIdForInput?.({ tabId: 'legacy', ...extra })).toBeUndefined();
    }
  });
  it('admits literal leading-colon filenames through file Actions and Find without admitting absolute paths', () => {
    const file = { target: { kind: 'session', sessionId: 'session-a', serverId: 'home-a' }, path: 'a:b.ts' };
    expect(WORKSPACE_ACTION_INPUT_SCHEMAS['workspace.tabs.open'].safeParse({ file }).success).toBe(true);
    expect(WORKSPACE_ACTION_INPUT_SCHEMAS['workspace.files.link.get'].safeParse(file).success).toBe(true);
    expect(WORKSPACE_ACTION_INPUT_SCHEMAS['workspace.tabs.open'].safeParse({ file, find: {
      query: 'needle', target: { kind: 'session-file', sessionId: 'session-a', serverId: 'home-a',
        machineId: 'machine-a', rootPath: '/repo', path: file.path },
    } }).success).toBe(true);
    for (const path of ['C:', 'C:/outside.ts', 'C:\\outside.ts', '//server/share/outside.ts', '\\\\server\\share\\outside.ts', '../outside.ts']) {
      expect(WORKSPACE_ACTION_INPUT_SCHEMAS['workspace.tabs.open'].safeParse({ file: { ...file, path } }).success).toBe(false);
    }
  });
  it('admits a literal selected tilde entry without interpreting general home shorthand', () => {
    expect(isSafeWorkspaceFilePath('~notes.txt')).toBe(true);
    expect(isSafeWorkspaceFilePath('~')).toBe(false);
    expect(isSafeWorkspaceFilePath('~/notes.txt')).toBe(false);
    for (const path of ['../outside', 'src/../../outside', '/etc/passwd', 'C:/outside', 'src\\outside', 'src/./note', 'src\0note']) {
      expect(isSafeWorkspaceFilePath(path)).toBe(false);
    }
  });
  it('opens root-relative files through one addressed file arm, including splits and private Find', () => {
    const open = WORKSPACE_ACTION_INPUT_SCHEMAS['workspace.tabs.open'];
    const file = { target: { kind: 'session', sessionId: 'session-a', serverId: 'home-a' }, path: 'src/a.ts',
      anchor: { kind: 'range', filePath: 'src/a.ts', startLine: 3, endLine: 8 }, view: 'changes', blame: true,
      changesScope: { kind: 'turn', turnId: 'turn-a' } };
    expect(open.safeParse({ file, mode: 'preview' }).success).toBe(true);
    expect(open.safeParse({ file, mode: 'preview', present: false }).success).toBe(true);
    expect(open.safeParse({ file, mode: 'splitRight', present: false }).success).toBe(false);
    expect(open.safeParse({ href: '/session/session-a', present: false }).success).toBe(false);
    expect(open.safeParse({ file, mode: 'splitRight' }).success).toBe(true);
    expect(open.safeParse({ file, href: '/session/other' }).success).toBe(false);
    expect(open.safeParse({ file, mode: 'splitRight', tabId: 'replace' }).success).toBe(false);
    for (const path of ['/etc/passwd', '../outside.ts', 'src/../../outside', 'C:\\outside.ts', '~/.ssh/id', 'src\\a.ts']) {
      expect(open.safeParse({ file: { ...file, path } }).success).toBe(false);
    }
    const project = { target: { kind: 'project', workspaceRefId: 'workspace-a', serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' }, path: 'src/a.ts' };
    const find = { query: 'needle', target: { ...project.target, kind: 'project-file', path: project.path } };
    expect(open.safeParse({ file: project, find }).success).toBe(true);
    expect(open.safeParse({ file, find: { query: 'needle', target: {
      kind: 'session-file', sessionId: 'session-a', serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo', path: file.path,
    } } }).success).toBe(true);
    expect(WORKSPACE_ACTION_SPECS.find(spec => spec.id === 'workspace.tabs.open')).toMatchObject({ safety: 'safe', approval: { result: 'required' } });
  });
  it('discovers strict pane-scoped bulk closes with user-configurable approval', () => {
    for (const name of ['workspace.tabs.close_others', 'workspace.tabs.close_left', 'workspace.tabs.close_right', 'workspace.tabs.close_all']) {
      const actionId = ActionIdSchema.parse(name);
      const spec = getActionSpec(actionId);
      const input = name === 'workspace.tabs.close_all' ? { groupId: 'pane-main' } : { tabId: 'tab-main' };
      expect(spec.inputSchema.parse(input)).toEqual(input);
      expect(spec.inputSchema.safeParse({ ...input, accountId: 'another-account' }).success).toBe(false);
      expect(spec.executionPlacement).toBe('client');
      expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true });
      for (const surface of ['ui', 'agent', 'mcp', 'cli'] as const) {
        const context = { surface, authority: 'account_automation' } as const;
        const required = normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: [surface] } } });
        expect(resolveActionApprovalRouting({ actionId, spec, settings: required, context }).required).toBe(true);
        const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
        expect(resolveActionApprovalRouting({ actionId, spec, settings: waived, context }).required).toBe(false);
      }
    }
  });
  it('accepts semantic placement for kept opens and moves while rejecting ambiguous reorder positions', () => {
    expect(WORKSPACE_ACTION_INPUT_SCHEMAS['workspace.tabs.open'].safeParse({ href: '/session/a', groupId: 'target', beforeTabId: 'anchor', reuseExisting: true, mode: 'splitLeft' }).success).toBe(true);
    expect(WORKSPACE_ACTION_INPUT_SCHEMAS['workspace.tabs.move'].safeParse({ tabId: 'a', targetGroupId: 'target', beforeTabId: 'anchor' }).success).toBe(true);
    const reorder = WORKSPACE_ACTION_INPUT_SCHEMAS['workspace.tabs.reorder'];
    expect(reorder.safeParse({ tabId: 'a', beforeTabId: 'anchor' }).success).toBe(true);
    expect(reorder.safeParse({ tabId: 'a', beforeTabId: null }).success).toBe(true);
    expect(reorder.safeParse({ tabId: 'a', index: 0, beforeTabId: 'anchor' }).success).toBe(false);
    expect(reorder.safeParse({ tabId: 'a' }).success).toBe(false);
  });
  it('requires a destination for split opens without accepting replacement-tab semantics', () => {
    const open = WORKSPACE_ACTION_INPUT_SCHEMAS['workspace.tabs.open'];
    expect(open.safeParse({ mode: 'splitLeft' }).success).toBe(false);
    expect(open.safeParse({ href: '/session/a', mode: 'splitLeft', tabId: 'replace' }).success).toBe(false);
    expect(open.safeParse({ mode: 'newTab', beforeTabId: 'anchor' }).success).toBe(true);
  });

  it('discovers tab and layout capabilities through the canonical Action vocabulary', () => {
    for (const id of [
      'workspace.tabs.list', 'workspace.tabs.open', 'workspace.tabs.activate', 'workspace.tabs.close',
      'workspace.tabs.closed.list', 'workspace.tabs.reopen',
      'workspace.tabs.pin', 'workspace.tabs.move', 'workspace.tabs.reorder', 'workspace.groups.focus', 'workspace.groups.maximize',
      'workspace.groups.restore', 'workspace.split', 'workspace.resize',
    ]) {
      expect(ActionIdSchema.safeParse(id)).toEqual({ success: true, data: id });
    }
  });
  it('advertises CLI admission through the same reverse-client delivery', () => {
    for (const spec of WORKSPACE_ACTION_SPECS) {
      expect(spec.executionPlacement).toBe('client');
      expect(spec.surfaces).toMatchObject({ ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false });
      expect(spec.cli).toEqual({ acceptsServerId: true, commands: [] });
    }
    expect(WORKSPACE_ACTION_INPUT_SCHEMAS['workspace.split'].safeParse({ direction: 'right', availableSizePx: 1000 }).success).toBe(false);
    expect(WORKSPACE_ACTION_INPUT_SCHEMAS['workspace.resize'].safeParse({ splitId: 'split:1', ratio: 2 }).success).toBe(false);
  });
  it('keeps closed-tab discovery and reopen requests strict and client-scoped', () => {
    const list = WORKSPACE_ACTION_INPUT_SCHEMAS['workspace.tabs.closed.list'];
    const reopen = WORKSPACE_ACTION_INPUT_SCHEMAS['workspace.tabs.reopen'];
    expect(list.parse({})).toEqual({});
    expect(list.safeParse({ accountId: 'another-account' }).success).toBe(false);
    expect(reopen.parse({})).toEqual({});
    expect(reopen.parse({ tabId: ' tab:closed ' })).toEqual({ tabId: 'tab:closed' });
    expect(reopen.safeParse({ tabId: ' ' }).success).toBe(false);
    expect(reopen.safeParse({ tabId: 'tab:closed', groupId: 'another-group' }).success).toBe(false);
    expect(WORKSPACE_ACTION_SPECS.find(spec => spec.id === 'workspace.tabs.closed.list')?.sideEffectClass).toBe('read');
    expect(WORKSPACE_ACTION_SPECS.find(spec => spec.id === 'workspace.tabs.reopen')?.sideEffectClass).toBe('external');
  });
  it('validates closed-tab titles and targets without admitting mutable workspace geometry', () => {
    const schema = WORKSPACE_ACTION_OUTPUT_SCHEMAS['workspace.tabs.closed.list'];
    const tab = { id: 'tab:closed', target: { kind: 'session', params: { sessionId: 'session:1' } }, pinned: true, title: 'My session' };
    expect(schema.parse({ ok: true, tabs: [tab] })).toEqual({ ok: true, tabs: [tab] });
    expect(schema.parse({ ok: true, tabs: [{ ...tab, title: undefined }] }).tabs[0]?.title).toBeUndefined();
    expect(schema.safeParse({ ok: true, tabs: [], accountId: 'another-account' }).success).toBe(false);
    expect(schema.safeParse({ ok: true, tabs: [{ ...tab, groupId: 'group:old' }] }).success).toBe(false);
    expect(schema.safeParse({ ok: true, tabs: [{ ...tab, target: { ...tab.target, href: '/session/1' } }] }).success).toBe(false);
    expect(schema.safeParse({ ok: true, tabs: [{ ...tab, target: { kind: 'session', params: { sessionId: 1 } } }] }).success).toBe(false);
    expect(WORKSPACE_ACTION_OUTPUT_SCHEMAS['workspace.tabs.reopen'].safeParse({ ok: true, tabId: 'tab:closed' }).success).toBe(false);
  });
});
