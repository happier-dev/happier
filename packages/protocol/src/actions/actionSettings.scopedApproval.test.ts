import { describe, expect, it } from 'vitest';
import * as owner from './actionSettings.js';
import { applyAccountSettingMutationV1 } from '../account/settings/accountSettingMutationV1.js';

const machine = { kind: 'machine', machineId: 'A' } as const;
const environment = { kind: 'environment', environmentId: 'staging' } as const;
const row = { actionId: 'session.stop', scope: machine, approvalRequiredSurfaces: ['cli'], approvalWaivedSurfaces: [] };

describe('scoped Actions approval preferences', () => {
  it('treats a repeated exact choice as zero mutations, preserving row and surface order', () => {
    const settings = owner.normalizeActionsSettingsV1({ v: 1, actions: {}, scopedApprovalPreferences: [
      { ...row, approvalRequiredSurfaces: ['cli', 'mcp'] }, { ...row, scope: environment },
    ] });
    const repeated = owner.setScopedActionApprovalPreference({ settings, actionId: 'session.stop',
      scope: machine, surface: 'cli', mode: 'required' });
    expect(repeated).toBe(settings);
    expect(applyAccountSettingMutationV1({ actionsSettingsV1: settings }, { operations: [
      { op: 'set', key: 'actionsSettingsV1', value: repeated },
    ] }).status).toBe('unchanged');
  });
  it('round-trips unknown Action rows and deduplicates scope keys without losing sibling policy', () => {
    const settings = owner.normalizeActionsSettingsV1({ v: 1, actions: {}, scopedApprovalPreferences: [row,
      { ...row, approvalRequiredSurfaces: ['mcp'] }, { ...row, actionId: 'future.action', scope: environment }] });
    expect(settings).toHaveProperty('scopedApprovalPreferences', [
      { ...row, approvalRequiredSurfaces: ['cli', 'mcp'] }, { ...row, actionId: 'future.action', scope: environment },
    ]);
  });

  it('edits and restores one exact scope and surface, preserving rows on global writes', () => {
    const initial = owner.normalizeActionsSettingsV1({ v: 1, actions: {}, scopedApprovalPreferences: [row] });
    const selected = owner.setScopedActionApprovalPreference({ settings: initial, actionId: 'session.stop',
      scope: environment, surface: 'cli', mode: 'waived' });
    const global = owner.setActionApprovalOverride({ settings: selected, actionId: 'session.stop', surface: 'mcp', approvalRequired: true });
    expect(owner.readScopedActionApprovalPreference(global, 'session.stop', machine)).toEqual(row);
    expect(owner.readScopedActionApprovalPreference(global, 'session.stop', environment)?.approvalWaivedSurfaces).toEqual(['cli']);
    const restored = owner.setScopedActionApprovalPreference({ settings: global, actionId: 'session.stop',
      scope: environment, surface: 'cli', mode: 'inherit' });
    expect(owner.readScopedActionApprovalPreference(restored, 'session.stop', environment)).toBeUndefined();
    expect(owner.readScopedActionApprovalPreference(restored, 'session.stop', machine)).toEqual(row);
  });

  it('retains unchanged scoped-row identity at the normalization owner', () => {
    const previous = owner.normalizeActionsSettingsV1({ v: 1, actions: {}, scopedApprovalPreferences: [row] });
    const changed = owner.normalizeActionsSettingsV1({ v: 1, actions: {}, scopedApprovalPreferences: [row,
      { ...row, scope: environment }] }, previous);
    expect(owner.readScopedActionApprovalPreference(changed, 'session.stop', machine))
      .toBe(owner.readScopedActionApprovalPreference(previous, 'session.stop', machine));
  });

  it('rejects oversized UTF-8 serialized settings without mutating the stored candidate', () => {
    const raw = { actionsSettingsV1: { v: 1, actions: {}, scopedApprovalPreferences: [row] } };
    const candidate = { v: 1, actions: {}, scopedApprovalPreferences: [row,
      { ...row, actionId: '界'.repeat(22000), scope: environment }] };
    expect(applyAccountSettingMutationV1(raw, { operations: [{ op: 'set', key: 'actionsSettingsV1', value: candidate }] }))
      .toEqual({ status: 'invalid', reason: 'tooLarge' });
    expect(raw.actionsSettingsV1.scopedApprovalPreferences).toEqual([row]);
  });

  it('admits scoped rows within the existing byte boundary instead of imposing an entry cap', () => {
    const rows = Array.from({ length: 300 }, (_, index) => ({ ...row,
      scope: { kind: 'machine', machineId: String(index) } }));
    const result = applyAccountSettingMutationV1({}, { operations: [{ op: 'set', key: 'actionsSettingsV1',
      value: { v: 1, actions: {}, scopedApprovalPreferences: rows } }] });
    expect(result.status).toBe('applied');
    if (result.status === 'applied') expect(result.raw.actionsSettingsV1).toHaveProperty('scopedApprovalPreferences', rows);
  });

  it('preserves omitted scoped rows at the current merge owner and admits explicit clearing', () => {
    const raw = { actionsSettingsV1: { v: 1, actions: {}, scopedApprovalPreferences: [row] } };
    const result = applyAccountSettingMutationV1(raw, { operations: [{ op: 'set', key: 'actionsSettingsV1',
      value: { v: 1, actions: { 'session.stop': { enabled: false } } } }] });
    expect(result.status).toBe('applied');
    if (result.status === 'applied') expect(result.raw.actionsSettingsV1).toHaveProperty('scopedApprovalPreferences', [row]);
    const clear = applyAccountSettingMutationV1(raw, { operations: [{ op: 'set', key: 'actionsSettingsV1',
      value: { v: 1, actions: {}, scopedApprovalPreferences: [] } }] });
    expect(clear.status).toBe('applied');
    if (clear.status === 'applied') expect(clear.raw.actionsSettingsV1).toHaveProperty('scopedApprovalPreferences', []);
  });
});
