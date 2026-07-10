import { describe, expect, it } from 'vitest';

import { PluginBackendCapabilitiesV1Schema } from '@happier-dev/plugin-sdk/manifest';

import { GEMINI_ACP_BACKEND_SPEC } from './agent/acp/definition.js';
import { PLUGIN_MANIFEST } from './manifest.js';

function capabilitiesForBackend(id: string) {
  const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === id);
  if (!backend) throw new Error(`Missing backend declaration: ${id}`);
  return PluginBackendCapabilitiesV1Schema.parse(backend.capabilities ?? {});
}

describe('Gemini plugin session media capabilities', () => {
  it('declares Gemini as a plugin-owned ACP backend contribution', () => {
    const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === 'gemini');

    expect(PLUGIN_MANIFEST.id).toBe('happier.agent.gemini');
    expect(PLUGIN_MANIFEST.uses).toContain('agents');
    expect(backend).toMatchObject({
      kindVersion: 1,
      id: 'gemini',
      runtime: {
        kind: 'acp',
      },
      capabilities: {
        executionRun: { supported: true },
      },
    });
    expect(backend?.runtime).toMatchObject({
      auth: GEMINI_ACP_BACKEND_SPEC.auth,
      transport: GEMINI_ACP_BACKEND_SPEC.transport,
      transportLifecycle: GEMINI_ACP_BACKEND_SPEC.transportLifecycle,
      permissionModeArgv: GEMINI_ACP_BACKEND_SPEC.permissionModeArgv,
      sessionIdHeaderName: GEMINI_ACP_BACKEND_SPEC.sessionIdHeaderName,
      stderrRules: GEMINI_ACP_BACKEND_SPEC.stderrRules,
      toolNameInference: GEMINI_ACP_BACKEND_SPEC.toolNameInference,
      mcp: GEMINI_ACP_BACKEND_SPEC.mcp,
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
    expect(PLUGIN_MANIFEST.uses).toContain('hooks');
    expect(PLUGIN_MANIFEST.contributes?.hooks).toContainEqual(expect.objectContaining({
      id: 'agent.resolvePrerequisites',
      hookApiVersion: 1,
      category: 'decision',
      scope: 'agent',
      filters: { agentId: 'gemini' },
      executionKind: 'decide',
      handler: {
        target: 'plugin',
        exportName: 'resolveGeminiDaemonSpawnPrerequisites',
      },
    }));
  });
});
