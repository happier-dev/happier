import { describe, expect, it } from 'vitest';
import { ScopeActionInputSchemas, ScopeActionOutputSchemas } from './scopeActionFamily.js';
import { SCOPE_ACTION_SPECS } from './specs/scope.js';

describe('File page client view contract', () => {
  it('admits selector-sized persisted viewer intents and rejects unknown mutation fields', () => {
    const schema = getActionSpec('file.view.preference.set').inputSchema;
    expect(schema.parse({ mutation: { kind: 'select', selector: { kind: 'mime', value: ' Text/Plain ' }, viewer: { kind: 'builtin' } }, expectedSettingsVersion: 7 }))
      .toEqual({ mutation: { kind: 'select', selector: { kind: 'mime', value: 'text/plain' }, viewer: { kind: 'builtin' } }, expectedSettingsVersion: 7 });
    expect(schema.safeParse({ mutation: { kind: 'clear', selector: { kind: 'extension', value: '.TXT' } } }).success).toBe(true);
    expect(schema.safeParse({ mutation: { kind: 'clear', selector: { kind: 'class', value: 'text' }, viewer: { kind: 'builtin' } } }).success).toBe(false);
    expect(schema.safeParse({ mutation: { kind: 'reset' } }).success).toBe(false);
  });

  it('admits named view controls and rejects unknown controls rather than dropping them', () => {
    const schema = ScopeActionInputSchemas['file.view.set'];
    expect(schema?.safeParse({ tabId: 'file:src/a.ts', mode: 'edit', blame: true, changesScope: { kind: 'turn', turnId: 'turn-a' } }).success).toBe(true);
    expect(schema?.safeParse({ changesScope: { kind: 'mystery' } }).success).toBe(false);
    expect(schema?.safeParse({ mode: 'compare' }).success).toBe(false);
    expect(schema?.safeParse({ track: true }).success).toBe(false);
  });
});
import { getActionSpec } from './actionSpecs.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { normalizeSessionListFilterV1 } from '../sessions/listFilter/sessionListFilterV1.js';

describe('Workflow Library client view contract', () => {
  it('admits closed mounted editor commands and requires agent approval', () => {
    expect(ScopeActionInputSchemas['file.editor.save'].parse({ tabId: 'file-a' })).toEqual({ tabId: 'file-a' });
    expect(ScopeActionInputSchemas['file.editor.save'].safeParse({ path: '/another/file' }).success).toBe(false);
    expect(ScopeActionInputSchemas['file.editor.resolve'].safeParse({ resolution: 'overwrite' }).success).toBe(false);
    for (const id of ['file.editor.save', 'file.editor.resolve'] as const) {
      const spec = getActionSpec(id);
      for (const surface of ['agent', 'mcp', 'cli'] as const) {
        expect(isApprovalRequiredByActionsSettings(id, { v: 1, actions: {} }, { surface, authority: 'account_automation' })).toBe(true);
      }
      expect(spec.executionPlacement).toBe('client');
      expect(ScopeActionOutputSchemas[id].parse({ status: 'unavailable' })).toEqual({ status: 'unavailable' });
      expect(ScopeActionOutputSchemas[id].safeParse({ status: 'unavailable', hidden: true }).success).toBe(false);
    }
  });
  it('addresses every shell column while retaining the legacy navigation input', () => {
    expect(ScopeActionInputSchemas['shell.column.get'].parse({})).toEqual({});
    expect(ScopeActionInputSchemas['shell.column.set'].parse({ visible: true })).toEqual({ visible: true });
    expect(ScopeActionInputSchemas['shell.column.set'].parse({ column: 'side', visible: false, tab: 'files' }))
      .toEqual({ column: 'side', visible: false, tab: 'files' });
    expect(ScopeActionInputSchemas['shell.column.get'].safeParse({ column: 'other' }).success).toBe(false);
    const projection = { present: true, visible: false, available: true, tabs: ['files', 'plugin:notes'], activeTab: 'files', label: 'Session' };
    expect(ScopeActionOutputSchemas['shell.column.get'].parse(projection)).toEqual(projection);
  });
  it('admits typed view and query inputs without dropping query text or accepting opaque commands', () => {
    const input = ScopeActionInputSchemas['workflow.library.view.set'];
    expect(input.parse({ filters: { view: 'triggered' }, searchQuery: '  Release  ' })).toEqual({ filters: { view: 'triggered' }, searchQuery: '  Release  ' });
    expect(input.safeParse({ filters: { view: 'history' } }).success).toBe(false);
    expect(input.safeParse({ searchQuery: 1 }).success).toBe(false);
    expect(input.safeParse({ view: 'running', command: { query: 'release' } }).success).toBe(false);
    expect(ScopeActionInputSchemas['workflow.library.view.get'].safeParse({ accountId: 'another-account' }).success).toBe(false);
  });

  it('accepts the typed Workflow filter independently of the transient search', () => {
    const input = ScopeActionInputSchemas['workflow.library.view.set'];
    expect(input.safeParse({ filters: { view: 'running' }, searchQuery: 'release' }).success).toBe(true);
    expect(input.safeParse({ filters: { view: 'all', state: 'archived' } }).success).toBe(false);
  });

  it('keeps inactive visibility inside the canonical Session filter input', () => {
    const input = ScopeActionInputSchemas['session.list.view.set'];
    expect(input.safeParse({ includeInactive: true }).success).toBe(false);
    expect(input.safeParse({ filters: { includeInactive: true } }).success).toBe(true);
  });

  it('reads saved opaque Session narrowing without making it a current writable field', () => {
    const filters = { ...normalizeSessionListFilterV1(), searchQuery: '', futureField: { include: ['narrow'] },
      extensions: { 'test.retired/stage': { kind: 'future', value: true } } };
    const readback = { view: { kind: 'global' }, storage: 'active', filters, selectedSpaceId: 'saved-space', coverage: 'unavailable',
      includeInactive: false, queryEnabled: true, followingAvailable: true, sourceAvailable: true, homes: [] };
    expect(ScopeActionOutputSchemas['session.list.view.get'].parse(readback)).toEqual(readback);
    expect(ScopeActionInputSchemas['session.list.view.set'].safeParse({ filters }).success).toBe(false);
  });

  it('keeps the observed mounted projection closed and routes all three operations to this client', () => {
    const observed = { view: 'running', filters: { view: 'running' }, searchQuery: 'release', offeredViews: ['all', 'running'], visibleKeys: ['release-notes'], coverage: 'complete', selectedSpaceId: 'all-workflows' };
    expect(ScopeActionOutputSchemas['workflow.library.view.get'].parse(observed)).toEqual(observed);
    expect(ScopeActionOutputSchemas['workflow.library.view.get'].safeParse({ ...observed, hiddenMembers: ['secret'] }).success).toBe(false);
    for (const id of ['workflow.library.view.get', 'workflow.library.view.set', 'workflow.library.view.reset']) {
      const spec = SCOPE_ACTION_SPECS.find(spec => spec.id === id)!;
      expect(spec.executionPlacement).toBe('client');
      expect(spec.surfaces).toMatchObject({ agent: true, mcp: true, rpc: false });
    }
  });
});

describe('Discussion client filter contract', () => {
  it('admits independent AND conditions and an exact Account target with safe client Actions', () => {
    const set = ScopeActionInputSchemas['discussion.list.view.set'];
    const target = { serverId: 'home-a', accountId: 'account-a' };
    expect(set.safeParse({ ...target, filters: { state: 'active', attention: 'needs_you', unreadOnly: true } }).success).toBe(true);
    expect(set.safeParse({ ...target, filters: { view: 'running' } }).success).toBe(false);
    expect(set.safeParse({ ...target, filters: { state: 'active', attention: 'any', unreadOnly: false, hidden: true } }).success).toBe(false);
    expect(set.safeParse({ ...target, filters: { unreadOnly: true } }).success).toBe(false);
    expect(ScopeActionInputSchemas['discussion.list.view.get'].safeParse({}).success).toBe(false);
    for (const id of ['discussion.list.view.get', 'discussion.list.view.set', 'discussion.list.view.reset'] as const) {
      expect(getActionSpec(id).executionPlacement).toBe('client');
      expect(isApprovalRequiredByActionsSettings(id, { v: 1, actions: {} }, { surface: 'agent', authority: 'account_automation' })).toBe(false);
    }
  });
});

describe('Settings column client filter contract', () => {
  const target = { column: 'skills', serverId: 'home-a', accountId: 'account-a' } as const;
  const filters = { source: { include: ['registry:team'], exclude: ['written'] } };

  it('admits the exact column targets through the Action catalog with safe client operations', () => {
    for (const column of ['connected-services', 'skills', 'mcp', 'agents', 'providers', 'plugins', 'store'] as const) {
      for (const id of ['settings.column.filter.get', 'settings.column.filter.set', 'settings.column.filter.clear'] as const) {
        const spec = getActionSpec(id);
        const input = { ...target, column, ...(id === 'settings.column.filter.set' ? { filters } : {}) };
        expect(spec.inputSchema.parse(input)).toEqual(input);
        expect(spec.executionPlacement).toBe('client');
        expect(isApprovalRequiredByActionsSettings(id, { v: 1, actions: {} },
          { surface: 'agent', authority: 'account_automation' })).toBe(false);
      }
    }
    expect(getActionSpec('settings.column.filter.set').inputSchema.parse({ ...target, filters: {} }))
      .toEqual({ ...target, filters: {} });
    expect(getActionSpec('settings.column.filter.set').inputSchema.parse({ ...target, filters, searchQuery: '' }))
      .toEqual({ ...target, filters, searchQuery: '' });
    expect(getActionSpec('settings.column.filter.get').inputSchema.safeParse({ ...target, includeSearchQuery: true }).success).toBe(false);
  });

  it('rejects incomplete or unknown targets and malformed replacement selections instead of dropping them', () => {
    const set = getActionSpec('settings.column.filter.set').inputSchema;
    for (const input of [
      { ...target }, { ...target, filters, column: 'sessions' },
      { serverId: 'home-a', accountId: 'account-a', filters },
      { column: 'skills', accountId: 'account-a', filters },
      { column: 'skills', serverId: 'home-a', filters },
      { ...target, filters, serverId: '' }, { ...target, filters, accountId: '   ' },
      { ...target, filters, hidden: true },
      { ...target, filters: { source: undefined } },
      { ...target, filters: { source: { include: ['registry:team'] } } },
      { ...target, filters: { source: { include: [1], exclude: [] } } },
      { ...target, filters: { source: { include: [], exclude: [], hidden: true } } },
    ]) expect(set.safeParse(input).success).toBe(false);
    for (const id of ['settings.column.filter.get', 'settings.column.filter.clear'] as const) {
      const schema = getActionSpec(id).inputSchema;
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ ...target, filters }).success).toBe(false);
    }
  });

  it('returns a closed exact-scope read projection with truthful count and coverage', () => {
    const schema = getActionSpec('settings.column.filter.get').outputSchema;
    const result = { ...target, filters, matchedCount: 0, coverage: 'unavailable' };
    expect(schema.parse({ ...result, searchQuery: '' })).toEqual({ ...result, searchQuery: '' });
    for (const coverage of ['complete', 'partial', 'unavailable']) {
      expect(schema.parse({ ...result, coverage })).toEqual({ ...result, coverage });
    }
    for (const invalid of [
      { ...result, matchedCount: -1 }, { ...result, matchedCount: 0.5 },
      { ...result, coverage: 'unknown' }, { ...result, hidden: true },
      { ...result, filters: { source: { include: [], exclude: [], hidden: true } } },
    ]) expect(schema.safeParse(invalid).success).toBe(false);
    for (const id of ['settings.column.filter.set', 'settings.column.filter.clear'] as const) {
      expect(getActionSpec(id).outputSchema.parse({ ok: true })).toEqual({ ok: true });
      expect(getActionSpec(id).outputSchema.safeParse({ ok: true, filters }).success).toBe(false);
    }
  });
});
