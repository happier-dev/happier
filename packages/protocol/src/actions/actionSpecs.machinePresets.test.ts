import { describe, expect, it } from 'vitest';
import { MACHINE_PRESET_ACTION_IDS_V1 } from '../machines/managed/machinePresetActionsV1.js';
import { ACTION_IDS } from './actionIds.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { getActionSpec, listActionCliCommandDeclarations, listVoiceToolActionSpecs, PLUGIN_INVOCABLE_ACTION_IDS, PUBLIC_ACTION_IDS } from './actionSpecs.js';

describe('personal and Team Machine preset Actions', () => {
  it('carries every exact-Home intent through the canonical headless catalog and asks before mutation', () => {
    const commands = new Map(listActionCliCommandDeclarations().map(({ spec, binding }) => [spec.id, binding.path]));
    const voice = new Set(listVoiceToolActionSpecs().map(spec => spec.id));
    for (const id of MACHINE_PRESET_ACTION_IDS_V1) {
      expect(ACTION_IDS).toContain(id);
      expect(PUBLIC_ACTION_IDS).toContain(id);
      expect(PLUGIN_INVOCABLE_ACTION_IDS).toContain(id);
      const read = id === 'machines.presets.list' || id === 'machines.presets.get';
      const spec = getActionSpec(id);
      expect(spec).toMatchObject({ executionPlacement: 'account', sideEffectClass: read ? 'read' : 'danger',
        surfaces: { ui: true, agent: true, cli: true, mcp: true, voice: true },
        serverTransport: { method: 'POST', path: `/v1/machines/presets/${id.split('.').at(-1)}` } });
      expect(commands.get(id)).toEqual(id.split('.'));
      expect(voice.has(id)).toBe(true);
      if (!read) expect(resolveActionApprovalRouting({ actionId: id, spec, context: { surface: 'agent' } }).required).toBe(true);
    }
  });
});
