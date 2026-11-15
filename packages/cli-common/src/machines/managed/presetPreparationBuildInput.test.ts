import { describe, expect, it } from 'vitest';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { ValidatedLaunchSnapshotV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { prepareManagedGuestCliBuildInput } from '../../systemTasks/ssh/managedGuestCliSupplier.js';
import * as managed from './presetPreparationBuildInput.js';

const launch = ValidatedLaunchSnapshotV1Schema.parse({ provider: { pluginId: 'test.compute', localId: 'guest' },
  schemaVersion: 1, name: 'Private guest name', choices: { image: 'ubuntu', architecture: 'x64', location: 'test-region' },
  credentials: [{ purpose: { consumer: { pluginId: 'test.compute', localId: 'guest' }, purpose: 'compute' },
    account: { service: { pluginId: 'test.service', localId: 'compute' }, accountId: 'private-connected-account' } }] });
const buildLaunch = { provider: launch.provider, schemaVersion: launch.schemaVersion, choices: launch.choices };

async function prepareCli() {
  return await prepareManagedGuestCliBuildInput({ homeUrl: 'https://private-home.example',
    target: { os: 'linux', arch: 'x64' },
    fetchImpl: async () => Response.json({ capabilities: { guestCli: { source: 'home-payload', line: '0.3', channel: 'stable' } } }),
    prepareLocalPayload: async () => ({ identity: 'a'.repeat(64), versionId: '0.3.0',
      target: { os: 'linux', arch: 'x64' }, archive: { contentsBase64: 'cGF5bG9hZA==', rootDirectory: 'payload' } }),
  });
}

describe('credential-free preset preparation build composition', () => {
  it('builds a fresh CLI image from the canonical supplier without introducing Account or enrollment input', async () => {
    const cli = await prepareCli();
    for (const setup of [undefined, {}]) {
      const composed = managed.composeManagedMachinePresetPreparationBuildInputV1({ launch, cli, setup });
      expect(composed).toEqual({ input: { launch: buildLaunch, cli } });
      expect(composed.input.cli.identity).toBe(`home-payload:${'a'.repeat(64)}`);
      expect(composed.input.cli.files).toEqual([{ path: 'happier-cli-payload.tar.gz', contentsBase64: 'cGF5bG9hZA==' }]);
      expect(JSON.stringify(composed.input)).not.toContain('private-home.example');
      expect(JSON.stringify(composed.input)).not.toMatch(/Private guest name|private-connected-account|test.service|credentials/u);
    }
  });

  it('keeps explicitly credential-bearing setup and its ordered dependencies entirely outside image input', async () => {
    const cli = await prepareCli();
    const setup: MachineSetupV1 = {
      toolchain: { adapterId: 'mise', config: '[tools]\nnode = "22"' },
      items: [{ kind: 'setupRecipe', selection: { ref: { pluginId: 'test.recipes', recipeId: 'service', revision: '1' },
        inputs: { credential: formatSharedSavedSecretRefV1('private-service') } } }],
      scripts: [{ body: 'configure-service --credential "$SERVICE_CREDENTIAL"', affects: 'none' },
        { body: 'initialize-dependent-workspace', affects: 'none' }],
      secretRefs: { v: 1, bindings: { SERVICE_CREDENTIAL: { ref: formatSharedSavedSecretRefV1('private-service'), revision: 7 } } },
    };
    const composed = managed.composeManagedMachinePresetPreparationBuildInputV1({ launch, cli, setup });
    expect(composed).toEqual({ input: { launch: buildLaunch, cli }, deferredSetup: setup });
    expect(JSON.stringify(composed.input)).not.toMatch(/SERVICE_CREDENTIAL|private-service|initialize-dependent-workspace|mise/u);
    expect(composed).not.toHaveProperty('bakedSetup');
  });

  it('defers whole setup when recipe target facts or ordering have not been classified by the canonical setup owner', async () => {
    const cli = await prepareCli();
    const setups: MachineSetupV1[] = [
      { items: [{ kind: 'softwareRecipe', selection: { ref: { pluginId: 'test.recipes', recipeId: 'docker', revision: '1' }, inputs: {} } }] },
      { toolchain: { adapterId: 'mise', config: '[tools]\nnode = "22"' } },
      { scripts: [{ body: 'install-ordinary-tool', affects: 'none' }, { body: 'use-ordinary-tool', affects: 'none' }] },
    ];
    for (const setup of setups) {
      expect(managed.composeManagedMachinePresetPreparationBuildInputV1({ launch, cli, setup }))
        .toEqual({ input: { launch: buildLaunch, cli }, deferredSetup: setup });
    }
  });
});
