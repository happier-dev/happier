import { describe, expect, it } from 'vitest';

import { PluginBackendCapabilitiesV1Schema } from '@happier-dev/plugin-sdk/experimental/manifest/agents';

import { PLUGIN_MANIFEST } from './manifest.js';

function capabilitiesForBackend(id: string) {
  const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === id);
  if (!backend) throw new Error(`Missing backend declaration: ${id}`);
  return PluginBackendCapabilitiesV1Schema.parse(backend.capabilities ?? {});
}

describe('Gemini plugin session media capabilities', () => {
  it('declares Gemini as a plugin-owned native Agent runtime contribution', () => {
    const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === 'gemini');

    expect(PLUGIN_MANIFEST.id).toBe('happier.agent.gemini');
    expect(PLUGIN_MANIFEST).not.toHaveProperty('uses');
    expect(backend).toMatchObject({
      id: 'gemini',
      primary: 'sessions',
      runtime: {
        kind: 'custom',
      },
      capabilities: {
        sessions: {
          open: ['create', 'resume'],
          delivery: ['newTurn', 'steer', 'followUp'],
          cancel: true,
        },
        executionRuns: {
          open: ['create'],
          checkpoint: true,
          stop: true,
        },
      },
    });
    expect(PLUGIN_MANIFEST.contributes.systemTools).toContainEqual({
      id: 'gemini-cli',
      title: 'Google Gemini CLI',
      executableNames: ['gemini'],
    });
  });

  it('keeps session media unsupported until source-real media events are mapped', () => {
    expect(capabilitiesForBackend('gemini').session.media).toEqual({
      acceptsImageInput: { supported: false },
      emitsSessionMedia: { supported: false },
      nativeImageGeneration: { supported: false },
    });
  });

  it('declares the Gemini auth prerequisite hook for packaged plugin projection', () => {
    expect(PLUGIN_MANIFEST.contributes?.hooks).toContainEqual(expect.objectContaining({
      id: 'resolve-prerequisites',
      on: 'agent.resolvePrerequisites',
      category: 'decision',
      scope: 'agent',
      filters: { agentId: 'gemini' },
      executionKind: 'decide',
    }));
  });
});
