import { describe, expect, it } from 'vitest';

import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { projectManifestContributionIntrospection } from './manifest';

describe('manifest contribution introspection', () => {
  it('uses the executable catalog rather than a partial hand-maintained family list', () => {
    const manifest = normalizePluginManifestV2({
      schemaVersion: 2,
      id: 'acme.manifest',
      version: '1.0.0',
      displayName: 'Manifest',
      engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
      contributes: {
        actions: [{
          id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'],
          placement: 'primary', dangerLevel: 'safe',
        }],
        commands: [{ id: 'command', title: 'Command', path: ['run'], action: 'run' }],
        voiceModelPacks: [],
      },
    });

    const projection = projectManifestContributionIntrospection({
      manifest,
      source: 'development',
      generation: 0,
      host: 'cli',
      platform: 'darwin',
      occurredAtMs: 1,
      diagnostics: [],
    });

    expect(projection.contributions.map((entry) => entry.contribution.family)).toEqual([
      'actions',
      'commands',
    ]);
    expect(projection.contributions.every((entry) => entry.progression.merged === false)).toBe(true);
  });
});
