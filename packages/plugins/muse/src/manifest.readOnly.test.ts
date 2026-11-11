import { expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { PLUGIN_MANIFEST } from './manifest.js';

it('admits Muse as capable of enforcing the Planner workspace-write denial', () => {
  const result = ingestPluginManifestV2(PLUGIN_MANIFEST);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Muse manifest admission failed');
  const agent = result.manifest.contributes.agents.find(agent => agent.id === 'muse');
  expect(agent?.capabilities.sessions?.workspaceWrites).toBe('deny');
});
