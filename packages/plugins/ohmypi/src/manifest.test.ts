import { readFileSync } from 'node:fs';
import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('OhMyPi plugin manifest', () => {
  it('is shippable and declares its custom session and external-session surfaces', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { happier?: { pluginScaffold?: { shipping?: unknown } } };
    expect(packageJson.happier?.pluginScaffold?.shipping).not.toBe('reservation_only');
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST.contributes.agents[0]).toMatchObject({
      id: 'ohmypi', runtime: { kind: 'custom' }, primary: 'sessions',
      capabilities: { surfaces: ['externalSessions'] },
      surfaces: {
        externalSession: {
          sources: [{
            sourceKind: 'ohMyPiAgentDir',
            key: {
              segments: [
                { kind: 'literal', value: 'ohMyPiAgentDir' },
                { kind: 'field', field: 'agentDir' },
              ],
            },
            instances: [{ kind: 'default', constants: {} }],
          }],
        },
      },
    });
  });

  it('declares the prerequisite hook as data without a handler reference', () => {
    expect(PLUGIN_MANIFEST.contributes.hooks).toEqual([
      expect.objectContaining({ id: 'resolve-prerequisites', on: 'agent.resolvePrerequisites', filters: { agentId: 'ohMyPi' } }),
    ]);
    expect(PLUGIN_MANIFEST.contributes.hooks[0]).not.toHaveProperty('handler');
  });
});
