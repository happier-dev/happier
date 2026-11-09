import { describe, expect, it, vi, afterEach } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import {
  getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot, subscribeActiveAccountSettingsKeys,
} from './activeAccountSettingsSnapshot';

afterEach(resetActiveAccountSettingsSnapshotForTests);

describe('scoped approval preference publication', () => {
  it('retains sibling row identity and wakes only the consumed Action/scope, including removal', () => {
    const scopeA = { kind: 'machine', machineId: 'A' } as const;
    const scopeB = { kind: 'environment', environmentId: 'B' } as const;
    const row = { actionId: 'session.stop', scope: scopeA, approvalRequiredSurfaces: ['cli'], approvalWaivedSurfaces: [] };
    const rows = [row, { ...row, scope: scopeB }];
    const publish = (next: typeof rows, version: number) => setActiveAccountSettingsSnapshot({
      source: 'network', scopeKey: 'account-A', settingsVersion: version, loadedAtMs: version,
      settingsSecretsReadKeys: [], settings: accountSettingsParse({ actionsSettingsV1: {
        v: 1, actions: {}, scopedApprovalPreferences: next,
      } }),
    });
    publish(rows, 1);
    const a = vi.fn();
    const b = vi.fn();
    const stopA = subscribeActiveAccountSettingsKeys({ actionApprovalPreferences: [{ actionId: row.actionId, scope: scopeA }] }, a);
    const stopB = subscribeActiveAccountSettingsKeys({ actionApprovalPreferences: [{ actionId: row.actionId, scope: scopeB }] }, b);
    const initialB = getActiveAccountSettingsSnapshot()?.settings.actionsSettingsV1.scopedApprovalPreferences?.[1];
    try {
      for (let index = 0; index < 25; index++) publish(JSON.parse(JSON.stringify(rows)), index + 2);
      expect(a).toHaveBeenCalledTimes(0);
      expect(b).toHaveBeenCalledTimes(0);
      publish([{ ...row, approvalRequiredSurfaces: ['cli', 'mcp'] }, rows[1]!], 27);
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(0);
      expect(getActiveAccountSettingsSnapshot()?.settings.actionsSettingsV1.scopedApprovalPreferences?.[1]).toBe(initialB);
      publish([rows[1]!], 28);
      expect(a).toHaveBeenCalledTimes(2);
      expect(b).toHaveBeenCalledTimes(0);
    } finally { stopA(); stopB(); }
  });
});
