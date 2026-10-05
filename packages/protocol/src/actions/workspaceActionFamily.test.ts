import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { WORKSPACE_ACTION_INPUT_SCHEMAS, WORKSPACE_ACTION_OUTPUT_SCHEMAS, WORKSPACE_ACTION_SPECS } from './workspaceActionFamily.js';

describe('workspace client actions', () => {
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
  it('publishes client execution on every requested surface without accepting caller-supplied geometry', () => {
    for (const spec of WORKSPACE_ACTION_SPECS) {
      expect(spec.executionPlacement).toBe('client');
      expect(spec.surfaces).toMatchObject({ ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false });
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
