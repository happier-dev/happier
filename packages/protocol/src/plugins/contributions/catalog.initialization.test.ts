import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';

// Match source preparation in a fresh Node ESM graph, independent of Vitest's loader.
const sourceImport = spawnSync(process.execPath, [
  '--conditions=happier-source', '--import', 'tsx', '--input-type=module', '-e',
  "await import('@happier-dev/protocol/plugins/contributions/v2'); console.log('contributions loaded')",
], {
  cwd: fileURLToPath(new URL('../../../../../', import.meta.url)),
  encoding: 'utf8',
});

// Evaluate the cold entry graph during collection, outside the behavior deadline.
vi.resetModules();
const protocol = await import('../../index.js');

it('loads the contribution source entry through a fresh Node ESM graph', () => {
  expect(sourceImport.error).toBeUndefined();
  expect(sourceImport.status, sourceImport.stderr).toBe(0);
  expect(sourceImport.stdout.trim()).toBe('contributions loaded');
});

it('initializes the contribution catalog through a fresh Protocol entry graph', () => {
  expect(protocol.PLUGIN_CONTRIBUTION_CATALOG_V2.map((entry) => entry.manifestKey))
    .toEqual(expect.arrayContaining(protocol.PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2.map((entry) => entry.family)));
  expect(protocol.PLUGIN_CONTRIBUTION_CATALOG_V2.length).toBeGreaterThan(0);
  expect(protocol.DaemonContributionRegistryProjectionDescribeResponseSchema).toBeDefined();
});
