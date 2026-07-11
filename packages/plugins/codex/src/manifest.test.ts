import { describe, expect, it } from 'vitest';

import {
  CODEX_ACP_INSTALLABLE_DESCRIPTOR,
  CODEX_ACP_RUNTIME_INSTALLABLE_ADAPTER_POLICY,
} from './agent/installables/codexAcp';
import { PLUGIN_MANIFEST } from './manifest';

describe('Codex plugin manifest', () => {
  it('declares the exact Responses provider intake owned by the Codex adapter', () => {
    const contribution = PLUGIN_MANIFEST.contributes.agents.find((entry) => entry.id === 'codex');

    expect(contribution?.providerSupport).toEqual({
      acceptsProtocols: ['openai-responses'],
      required: { streaming: true, toolRoundTrips: true },
      credentialSupport: {
        supportsNoAuth: true,
        apiKeyTransports: [{
          protocol: 'openai-responses',
          destination: {
            kind: 'httpHeader',
            names: 'anyValidated',
            formats: ['raw', 'bearer'],
          },
        }],
      },
      authIsolation: {
        suppressConnectedServiceIds: ['openai-codex', 'openai'],
        ownedEnvKeys: [
          'HAPPIER_CODEX_PROVIDER_API_KEY',
          'OPENAI_API_KEY',
          'CODEX_API_KEY',
        ],
      },
      materialization: 'engineConfig',
      applyPolicy: 'restart_session',
      supportsFreeformModelIds: true,
    });
  });

  it('declares agent settings as plugin-authored contribution data', () => {
    const contribution = PLUGIN_MANIFEST.contributes.agentSettings?.find((entry) => entry.agentId === 'codex');

    expect(contribution).toEqual(expect.objectContaining({
      id: 'codex.agentSettings.v1',
      kind: 'agentSettings.v1',
      storageScope: 'agentAccount',
    }));
    expect(contribution?.fields.map((field) => field.id)).toEqual(['codexBackendMode']);
    expect(contribution?.ui.sections).toEqual([
      expect.objectContaining({
        id: 'codexMode',
        fields: ['codexBackendMode'],
      }),
    ]);
  });

  it('scopes daemon spawn hooks to the Codex backend', () => {
    expect(PLUGIN_MANIFEST.contributes.hooks).toEqual([
      expect.objectContaining({
        id: 'agent.resolvePrerequisites',
        filters: { agentId: 'codex' },
      }),
      expect.objectContaining({
        id: 'agent.spawnEnv.augment',
        filters: { agentId: 'codex' },
      }),
    ]);
  });

  it('declares codex-acp as a plugin-owned system tool', () => {
    expect(PLUGIN_MANIFEST.contributes.systemTools).toContainEqual({
      toolId: 'codex-acp',
      displayName: 'Codex ACP',
      source: 'system',
      lookupNames: ['codex-acp'],
      defaultArgs: [],
    });
  });

  it('declares codex-acp as a plugin-owned installable dependency', () => {
    expect(PLUGIN_MANIFEST.contributes.managedDependencies).toContainEqual(CODEX_ACP_INSTALLABLE_DESCRIPTOR);
  });

  it('attaches the codex-acp runtime adapter policy to the installable descriptor', () => {
    expect(CODEX_ACP_INSTALLABLE_DESCRIPTOR.runtimeInstallableAdapterPolicy).toEqual(
      CODEX_ACP_RUNTIME_INSTALLABLE_ADAPTER_POLICY,
    );
  });
});
