import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec, listActionSpecs } from './actionSpecs.js';
import { actionSpecToActionDefinitionV1, searchSerializedActionSpecsForSurface } from './actionCatalog.js';

describe('Home hub customization Action parity', () => {
  it('makes the layout discoverable and exposes every customization intent without accepting layout authority from callers', () => {
    const ids = ['home.hub.layout.get', 'home.hub.layout.update', 'home.reachNudge.dismiss'];
    for (const id of ids) {
      expect(ActionIdSchema.safeParse(id).success, id).toBe(true);
      const spec = listActionSpecs().find((row) => row.id === id)!;
      const deviceLocal = id === 'home.reachNudge.dismiss';
      expect(spec.executionPlacement).toBe(deviceLocal ? 'client' : 'account');
      // Account customization is available headlessly; reachability dismissal belongs to this device.
      expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: !deviceLocal, rpc: !deviceLocal, api: true });
      expect(actionSpecToActionDefinitionV1(spec, { surface: 'agent' }).id).toBe(id);
      expect(searchSerializedActionSpecsForSurface({ query: id, surface: 'agent', isActionEnabled: (candidate) => ids.includes(candidate) }).some((row) => row.id === id)).toBe(true);
    }
    const update = getActionSpec('home.hub.layout.update');
    for (const intent of [
      { kind: 'reorder', sectionIds: ['usage', 'start', 'attention', 'setup', 'machines'] },
      { kind: 'move', sectionId: 'usage', step: -1 },
      { kind: 'visibility', sectionId: 'widget:acme/latest', hidden: false },
      { kind: 'reset' },
      { kind: 'restore_setup' },
      { kind: 'setup_visibility', stepId: 'addPhone', hidden: true },
    ]) expect(update.inputSchema.safeParse({ intent }).success, intent.kind).toBe(true);
    expect(update.inputSchema.safeParse({ intent: { kind: 'visibility', sectionId: 'usage', hidden: true, hideable: true } }).success).toBe(false);
    expect(update.inputSchema.safeParse({ intent: { kind: 'move', sectionId: 'usage', step: 4 } }).success).toBe(false);
    expect(update.inputSchema.safeParse({ layout: { order: [], hidden: [] } }).success).toBe(false);
  });
});
