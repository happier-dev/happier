import { expect, it } from 'vitest';

import { getActionSpecForCatalogSurface } from './actionCatalog.js';
import {
  AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS,
  resolveActionApprovalRouting,
} from './actionApprovalPolicy.js';
import { listActionSpecs, type ActionSpec, type ActionSurfaces } from './actionSpecs.js';

// 58d §D3 supplies the expectations; the registry supplies every Action id.
// Match families rather than copying their member lists, including the same-resource
// bootstrap continuation and reviewed setup children named by acquire's declaration.
const parityFamilies: readonly Readonly<{
  scope: RegExp;
  surfaces: Partial<ActionSurfaces>;
}>[] = [
  { scope: /^machines\.(provisioners|presets|managed|setup|agentIsolation)\./,
    surfaces: { ui: true, agent: true, mcp: true, cli: true } },
  { scope: /^machines\.agents\.signIn\./,
    surfaces: { ui: true, agent: true, mcp: true, cli: true } },
  { scope: /^connectedServices\.authentication\./,
    surfaces: { ui: true, agent: true, mcp: true, cli: true } },
  { scope: /^connectedServices\.(accounts\.(list|credentials\.save|rename|default\.set|purposeDefault\.set|revoke)|catalog\.list)$/,
    surfaces: { ui: true, agent: true, mcp: true, cli: true } },
  { scope: /^secrets\.(create|update|shared\.list)$/,
    surfaces: { ui: true, agent: true, mcp: true, cli: true } },
  { scope: /^machines\.access\.grant\.set$/,
    surfaces: { ui: true, agent: true, mcp: true, cli: true } },
  { scope: /^machines\.add\.(ssh\.|command$)/,
    surfaces: { ui: true, agent: true, mcp: true, cli: false, voice: false } },
  { scope: /^action\.operations\.get$/,
    surfaces: { ui: true, agent: true, mcp: true, cli: true } },
  // §D3's *.available names are option-source ids consumed by action.options.resolve,
  // not Action ids. Existing spawn inventory Actions keep their current surfaces.
  { scope: /^sessions\.spawn\./, surfaces: {} },
  { scope: /^action\.options\.resolve$/, surfaces: {} },
  { scope: /^settings\.(get|set)$/, surfaces: {} },
  { scope: /^inbox\./, surfaces: {} },
];

it('keeps app-first reads safe, agent danger/paid work Ask-first, and declared surfaces on the same Action', () => {
  const specs = listActionSpecs();
  const askByDefault = new Set(AGENT_INITIATED_APPROVAL_REQUIRED_ACTION_IDS);
  const failures: string[] = [];

  for (const family of parityFamilies) {
    if (!specs.some(spec => family.scope.test(spec.id))) failures.push(`Missing family: ${family.scope}`);
  }

  for (const spec of specs) {
    const family = parityFamilies.find(candidate => candidate.scope.test(spec.id));
    // Wake is part of the existing run-requiring Action, never its own id.
    const requiresRuntime = spec.machineRuntimeDemandForInput !== undefined;
    if (!family && !requiresRuntime) continue;

    if (spec.sideEffectClass === 'read' && spec.safety !== 'safe') {
      failures.push(`${spec.id}: read must stay safe`);
    }

    const agentRouting = (defaultSafety?: ActionSpec['safety']) => resolveActionApprovalRouting({
      actionId: spec.id, spec, defaultSafety,
      context: { surface: 'agent', authority: 'account_automation' },
    }).required;
    // Paid effects stay Ask even if a mistaken spec edit downgrades both classifications.
    const paid = /^machines\.managed\.(acquire|power\.set|retention\.update)$/.test(spec.id);
    if (spec.surfaces.agent && (paid || spec.safety === 'danger' || spec.sideEffectClass === 'danger')) {
      if (!askByDefault.has(spec.id) || !agentRouting()) failures.push(`${spec.id}: agent danger must default to Ask`);
    }
    if (spec.surfaces.agent && requiresRuntime && !agentRouting('danger')) {
      failures.push(`${spec.id}: paid wake must default to Ask with the host's danger classification`);
    }
    // Preserve safe writes/live continuations; §D3 G4 does not make every write dangerous.
    if (spec.surfaces.agent && spec.sideEffectClass === 'read' && agentRouting()) {
      failures.push(`${spec.id}: read must be Allowed by default`);
    }

    for (const surface of ['ui', 'agent', 'mcp', 'cli', 'voice'] as const) {
      const expected = family?.surfaces[surface];
      if (expected !== undefined && spec.surfaces[surface] !== expected) {
        failures.push(`${spec.id}: ${surface} must be ${expected ? 'available' : 'unavailable'}`);
      }
      const projected = getActionSpecForCatalogSurface({ id: spec.id, surface });
      if (spec.surfaces[surface] && projected?.id !== spec.id) {
        failures.push(`${spec.id}: ${surface} catalog must expose the same Action id`);
      }
      if (!spec.surfaces[surface] && projected !== null) {
        failures.push(`${spec.id}: unavailable ${surface} Action leaked into its catalog`);
      }
    }
  }

  expect(failures, '58d §D3 parity mismatches (fix the owning specs/policy, not the census)').toEqual([]);
});
