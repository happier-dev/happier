import { PluginManifestV2LoadSchema } from '@happier-dev/protocol/plugins/manifest';
import { readIndexedBundledDeclarationManifest } from '../../../../apps/cli/src/plugins/projection/registry/builtIn/declarationAssetFormat.mjs';
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { MachineProvisionerObservationV1Schema } from '../machineProvisioners.js';
import { LOCAL_OBSERVATION_CASES } from '../test-support/bundledObservationsLocal.js';
import { CLOUD_OBSERVATION_CASES } from '../test-support/bundledObservationsCloud.js';
import { NATIVE_OBSERVATION_CASES } from '../test-support/bundledObservationsNative.js';
import { CUA_DEVCONTAINER_OBSERVATION_CASES } from '../test-support/bundledObservationsCuaDevcontainer.js';

const scenarios = [...LOCAL_OBSERVATION_CASES, ...CLOUD_OBSERVATION_CASES, ...NATIVE_OBSERVATION_CASES, ...CUA_DEVCONTAINER_OBSERVATION_CASES];

// Fixtures replace native IO only; every observation crosses the real decoder
// and the provisioner's observation producer before reaching this contract.
describe('bundled provisioner observation facts', () => {
  it('covers every bundled provisioner contribution declared by the canonical manifests', () => {
    const manifests = new URL('../../../../apps/cli/assets/bundled-plugin-manifests/', import.meta.url);
    const declared = readdirSync(manifests).filter(name => name.endsWith('.json')).flatMap(name => {
      const manifest = PluginManifestV2LoadSchema.parse(readIndexedBundledDeclarationManifest(new URL(name, manifests)));
      return (manifest.contributes.machineProvisioners ?? []).map((provisioner: { id: string }) => `${name.slice(0, -5)}/${provisioner.id}`);
    });
    expect([...new Set(scenarios.map(scenario => `${scenario.plugin}/${scenario.provisioner}`))].sort()).toEqual(declared.sort());
  });
  for (const scenario of scenarios) {
    it(`${scenario.plugin}/${scenario.provisioner}/${scenario.state}`, async () => {
      // Authored PluginErrors remain typed refusals across the Action boundary.
      if ('expectedErrorCode' in scenario && scenario.expectedErrorCode) {
        await expect(scenario.observe()).rejects.toMatchObject({ code: scenario.expectedErrorCode });
        return;
      }
      const observation = await scenario.observe();
      expect(MachineProvisionerObservationV1Schema.safeParse(observation).success).toBe(true);
      expect(observation).toMatchObject(Object.fromEntries(Object.entries(scenario.expected).filter(([, value]) => value !== undefined)));
      for (const [key, value] of Object.entries(scenario.expected)) {
        if (value === undefined) expect(observation[key as keyof typeof observation]).toBeUndefined();
      }
    });
  }
});
