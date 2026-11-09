import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { DEVIN_PLUGIN } from '../manifest.js';
import { createDevinConnectedAccountLaunch, devinNativeHome } from './connectedAccount.js';

describe('Devin selected Account launch', () => {
  it('registers the native purpose without replacing its declarative ACP runtime', async () => {
    const kit = await createPluginTestkit({ manifest: DEVIN_PLUGIN.manifest, module: { activate: DEVIN_PLUGIN.activate } });
    try {
      const launch = kit.registration('agents', 'devin')?.connectedAccountLaunch;
      expect(launch?.stateSharingDescriptor?.authIsolation.secretEntries).toEqual(['devin/credentials.toml']);
      expect(DEVIN_PLUGIN.manifest.contributes.agents[0]).toMatchObject({
        runtime: { kind: 'acp', transport: { executable: { kind: 'systemTool', id: 'devin-cli' } } },
        connectedAccounts: [{ purpose: 'devin-native', service: 'devin-account', materializationKinds: ['files'] }],
      });
      expect(DEVIN_PLUGIN.manifest.contributes.connectedAccountDescriptors[0].authentication.native).toEqual({ systemTool: 'devin-cli' });
    } finally { await kit.dispose(); }
  });
  it('keeps POSIX data distinct from config and scopes Windows APPDATA to named Devin entries', () => {
    expect(devinNativeHome('darwin')).toMatchObject({ environmentKey: 'XDG_DATA_HOME', defaultRelativePath: '.local/share', materializedRootOverlay: { privateEntries: ['devin'] } });
    expect(devinNativeHome('win32')).toMatchObject({ environmentKey: 'APPDATA', defaultRelativePath: 'AppData/Roaming' });
    expect(createDevinConnectedAccountLaunch('win32').stateSharingDescriptor?.config.entries.map(entry => entry.path)).toEqual(['devin/config.toml', 'devin/mcp_config.json', 'devin/skills']);
  });
});
