import { describe, expect, it } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

import { listBuiltInHappierTools } from './listBuiltInHappierTools';

describe('Happier built-in tool catalog convergence', () => {
  it.each([
    { name: 'execution_run_start', actionId: 'execution.run.start', surface: 'cli' },
    { name: 'plugins_reload', actionId: 'plugins.reload', surface: 'agent' },
  ] as const)('keeps $name Action-backed and withdraws it when its canonical policy disables it', ({ name, actionId, surface }) => {
    const registry = createResolvedContributionRegistry({ agents: [] });
    const enabledTools = listBuiltInHappierTools({
      surface, registry, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
    });
    expect(enabledTools.filter((tool) => tool.name === name)).toEqual([
      expect.objectContaining({ name, actionId }),
    ]);

    const disabledTools = listBuiltInHappierTools({
      surface,
      registry,
      actionsSettings: ActionsSettingsV1Schema.parse({
        v: 1, actions: { [actionId]: { enabled: false } },
      }),
    });
    expect(disabledTools.map((tool) => tool.name)).toContain('action_execute');
    expect(disabledTools.map((tool) => tool.name)).not.toContain(name);
  });
});
