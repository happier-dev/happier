import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const externalSessionsDocPath = fileURLToPath(
  new URL('../content/docs/plugins/surfaces/external-sessions.mdx', import.meta.url),
);

test('documents definePlugin-only External Session authoring without retired registration paths', () => {
  const source = readFileSync(externalSessionsDocPath, 'utf8');

  for (const requiredSource of [
    "import { definePlugin } from '@happier-dev/plugin-sdk'",
    'export const { manifest, activate } = definePlugin({',
    'AgentExternalSessionHooksContribution',
    'externalSessions,',
    'externalSessionHooks: hooks,',
    'externalSessionTakeover: takeover,',
    'externalSessionObservation: observation,',
    'installationVariants',
    'resolveInstallation(request, context)',
    'mapHookEvent(request)',
  ]) {
    assert.match(source, new RegExp(requiredSource.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }

  for (const retiredSource of [
    'describeInstallation',
    'planConfiguration',
    'registerExternalSessionHookRecipes',
    'hookRecipes',
    'PluginApi',
    'api.agents.registerExternalSessions',
    'api.agents.registerExternalSessionHooks',
    'api.agents.registerExternalSessionTakeover',
    'api.agents.registerExternalSessionObservation',
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(retiredSource.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
    );
  }
});
