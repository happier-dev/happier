import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { getActionRequiredServerFeatureId } from './actionRequiredServerFeature.js';

describe('browser extension Action contract', () => {
  it('consumes the Store selected version through the extension update Action', () => {
    const parsed = ActionIdSchema.safeParse('browser.extensions.update');
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const spec = getActionSpec(parsed.data);
    const input = { machineId: 'machine', profileId: 'profile', extensionId: 'a'.repeat(32), expectedVersion: '2.0' };
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, expectedVersion: undefined }).success).toBe(false);
    expect(spec.safety).toBe('danger');
  });
  it('admits exact profile operations through the browser runtime family', () => {
    for (const operation of ['list', 'install', 'enable', 'disable', 'remove', 'openActionPopup', 'openOptions']) {
      const parsed = ActionIdSchema.safeParse(`browser.extensions.${operation}`);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      const spec = getActionSpec(parsed.data);
      expect(spec.executionPlacement).toBe('machine');
      expect(spec.surfaces).toMatchObject({ ui: true, agent: true, cli: true, rpc: true, mcp: true });
      expect(getActionRequiredServerFeatureId(parsed.data)).toBe(null);
      const target = { machineId: 'machine', profileId: 'profile' };
      const input = operation === 'install' ? { ...target, source: { kind: 'webStore', extensionId: 'a'.repeat(32) } }
        : operation === 'openActionPopup' || operation === 'openOptions' ? { ...target, extensionId: 'a'.repeat(32),
          commandId: 'open', browserSessionId: 'browser', viewId: 'view' }
        : operation === 'list' ? target : { ...target, extensionId: 'a'.repeat(32) };
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
      expect(spec.inputSchema.safeParse({ ...input, token: 'unexpected' }).success).toBe(false);
      if (['install', 'enable', 'disable', 'remove'].includes(operation)) expect(spec.safety).toBe('danger');
    }
  });

  it('allows machine-wide installed discovery and rejects profileless mutation', () => {
    const list = ActionIdSchema.safeParse('browser.extensions.list');
    expect(list.success).toBe(true);
    if (list.success) expect(getActionSpec(list.data).inputSchema.safeParse({ machineId: 'machine' }).success).toBe(true);
    const install = ActionIdSchema.safeParse('browser.extensions.install');
    expect(install.success).toBe(true);
    if (install.success) expect(getActionSpec(install.data).inputSchema.safeParse({ machineId: 'machine',
      source: { kind: 'unpacked', directory: '/extension' } }).success).toBe(false);
  });
});
