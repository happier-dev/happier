import { describe, expect, it } from 'vitest';

import { ACTION_SPEC_FAMILY_IDS, ACTION_SPEC_FAMILY_READERS, ACTION_SPEC_UI_PLACEMENT_IDS } from './actionSpecFamilies.generated.js';
import { getActionSpec, listActionSpecBindingDeclarations, listActionSpecMcpToolBindings, listActionSpecs } from './actionSpecs.js';

const REGENERATE = 'stale: run node packages/protocol/scripts/generateActionSpecFamilies.mjs';

describe('Action spec family routing', () => {
  it('keeps Session menu handoff and compact reachable through the generic palette', () => {
    for (const id of ['session.handoff', 'session.compact'] as const) {
      expect(getActionSpec(id).placements).toContain('command_palette');
      expect(ACTION_SPEC_UI_PLACEMENT_IDS.command_palette).toContain(id);
    }
  });

  it('keeps person-facing commands while leaving gesture, field and raw-read operations to their own surfaces', () => {
    const paletteIds = ACTION_SPEC_UI_PLACEMENT_IDS.command_palette;
    for (const id of [
      'ui.voice_global.hold_begin', 'ui.voice_global.hold_release', 'ui.voice_global.hold_cancel',
      'ui.voice_global.dictation.start', 'ui.voice_global.dictation.finish', 'ui.voice_global.dictation.cancel',
      'ui.voice_global.dictation.dismiss', 'ui.voice_global.dictation.retry', 'ui.voice_global.position.set',
      'ui.voice_global.conversations.list', 'ui.voice_global.history.search', 'ui.voice_global.history.load_older',
      'execution.run.get',
    ] as const) {
      expect(paletteIds, id).not.toContain(id);
      const spec = getActionSpec(id);
      expect(spec.placements, id).not.toContain('command_palette');
      expect(spec.surfaces, id).toMatchObject({ ui: true, agent: true, mcp: true });
    }
    for (const id of [
      'ui.voice_global.get', 'ui.voice_global.start', 'ui.voice_global.end', 'ui.voice_global.set_muted',
      'ui.voice_global.recover', 'ui.voice_global.turn_control', 'ui.voice_global.brief.request',
      'ui.voice_global.say.start', 'ui.voice_global.setup.open', 'ui.voice_global.history.export',
      'execution.run.list', 'session.fork', 'memory.search',
    ]) expect(paletteIds, id).toContain(id);
  });

  it('routes every catalog id, in catalog order, to the family that declares it', () => {
    const catalogIds = listActionSpecBindingDeclarations().map((declaration) => declaration.id);
    const routedIds = ACTION_SPEC_FAMILY_READERS.flatMap((read) => read().map((row) => row.id));
    expect(routedIds, REGENERATE).toEqual(catalogIds);
    expect(ACTION_SPEC_FAMILY_IDS, REGENERATE).toEqual(ACTION_SPEC_FAMILY_READERS.map((read) => read().map((row) => row.id)));
  });

  it('resolves each id through its family to the same declaration the catalog lists', () => {
    for (const ids of ACTION_SPEC_FAMILY_IDS) {
      for (const id of ids) expect(getActionSpec(id as Parameters<typeof getActionSpec>[0]).id).toBe(id);
    }
  });

  it('lists named MCP tool bindings exactly as the catalog declares them', () => {
    const expected = listActionSpecBindingDeclarations().flatMap(({ id, bindings }) => {
      const name = bindings?.mcpToolName?.trim();
      return name ? [[name, id]] : [];
    });
    expect(listActionSpecMcpToolBindings(), REGENERATE).toEqual(expected);
  });

  it('lists UI placement ids exactly as the normalized catalog declares them', () => {
    const expected: Record<string, string[]> = {};
    for (const spec of listActionSpecs()) {
      if (spec.surfaces.ui !== true) continue;
      for (const placement of spec.placements ?? []) (expected[placement] ??= []).push(spec.id);
    }
    expect(ACTION_SPEC_UI_PLACEMENT_IDS, REGENERATE).toEqual(expected);
  });
});
