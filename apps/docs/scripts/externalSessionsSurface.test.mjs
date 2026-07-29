import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const externalSessionsDocPath = fileURLToPath(
  new URL('../content/docs/plugins/surfaces/external-sessions.mdx', import.meta.url),
);

test('documents the exact External Session hooks contribution without retired planning APIs', () => {
  const source = readFileSync(externalSessionsDocPath, 'utf8');

  for (const requiredSource of [
    'AgentExternalSessionHooksContribution',
    "api.agents.registerExternalSessionHooks('example', hooks)",
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
  ]) {
    assert.doesNotMatch(source, new RegExp(`\\b${retiredSource}\\b`, 'u'));
  }
});
