import { describe, expect, it } from 'vitest';

import { PluginBackendCapabilitiesV1Schema } from '@happier-dev/plugin-sdk/manifest';

import { PLUGIN_MANIFEST } from './manifest.js';

function capabilitiesForBackend(id: string) {
  const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === id);
  if (!backend) throw new Error(`Missing backend declaration: ${id}`);
  return PluginBackendCapabilitiesV1Schema.parse(backend.capabilities ?? {});
}

describe('Claude plugin session media capabilities', () => {
  it('declares Claude as an agent contribution with final agent CLI runtime vocabulary', () => {
    const agent = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === 'claude');

    expect(agent).toEqual(expect.objectContaining({
      id: 'claude',
      ownedBackendIds: ['claude'],
      agentCliRuntime: expect.objectContaining({
        id: 'claude',
        binaryName: 'claude',
      }),
    }));
    const legacyRuntimeKey = 'provider' + 'CliRuntime';
    expect(agent && legacyRuntimeKey in agent).toBe(false);
  });

  it('declares execution-run support explicitly in the backend manifest', () => {
    const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === 'claude');

    expect(backend?.capabilities?.executionRun).toEqual({ supported: true });
  });

  it('declares terminal-host runtime control through manifest capabilities', () => {
    expect(PLUGIN_MANIFEST.uses).toContain('terminalHost');
    expect(PLUGIN_MANIFEST.permissions.required).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: 'terminal.host.control' }),
      expect.objectContaining({ capability: 'events.session.subscribe' }),
    ]));
  });

  it('declares only tool-output SDK image blocks without claiming native image generation', () => {
    const capabilities = capabilitiesForBackend('claude');

    expect(capabilities.session.media.emitsSessionMedia).toMatchObject({
      supported: true,
      mediaKinds: ['image'],
      sources: ['tool-output'],
      storage: 'session-media-file',
    });
    expect(capabilities.session.media.nativeImageGeneration.supported).toBe(false);
  });
});
