import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

describe('AGENT_DEFINITION', () => {
  it('declares the Codex app-server control surface at the plugin catalog boundary', () => {
    expect(AGENT_DEFINITION.core).toMatchObject({
      id: 'codex',
      resume: { vendorResume: 'experimental', vendorResumeIdField: 'codexSessionId' },
      sessionStorage: { direct: true, persisted: true },
      sessionCapabilities: {
        sessionListing: 'supported',
        sessionFork: { conversation: 'supported', fromMessage: 'unsupported' },
        sessionRollback: { conversation: 'supported' },
        usageLimitRecovery: { checkNow: 'supported' },
      },
      runtimeKinds: {
        defaultKind: 'appServer',
        byKind: {
          acp: {
            overrides: {
              sessionCapabilities: {
                sessionFork: { conversation: 'unsupported' },
                sessionRollback: { conversation: 'unsupported' },
                usageLimitRecovery: { checkNow: 'unsupported' },
              },
            },
          },
          appServer: { kind: 'appServer' },
        },
      },
    });
  });

  it('keeps strict CLI/auth authority in the native manifest', () => {
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.cli).toMatchObject({
      executable: { binaryName: 'codex' },
      install: { recommendationOrder: 20 },
    });
    expect(AGENT_DEFINITION).not.toHaveProperty('agentCliRuntime');
    const legacyRuntimeKey = 'provider' + 'CliRuntime';
    expect(legacyRuntimeKey in AGENT_DEFINITION).toBe(false);
  });

  it('keeps only the released flat-metadata compatibility fact', () => {
    expect(AGENT_DEFINITION).toMatchObject({
      releasedFlatSessionMetadataRuntimeDescriptorReader: {
        kind: 'providerRuntimeDescriptorReader',
        providerId: 'codex',
        generatedReader: expect.objectContaining({ providerId: 'codex' }),
      },
    });
    expect(AGENT_DEFINITION).not.toHaveProperty('sessionControlAdapter');
    expect(AGENT_DEFINITION).not.toHaveProperty('runtimeContributions');
    expect(AGENT_DEFINITION).not.toHaveProperty('protocolRuntimeDescriptor');
    expect(AGENT_DEFINITION).not.toHaveProperty('protocolBuiltInBackendProfiles');
    expect(
      AGENT_DEFINITION.releasedFlatSessionMetadataRuntimeDescriptorReader.generatedReader.runtimeKind.aliases,
    ).toContainEqual({ input: 'mcp', runtimeKind: 'mcp' });
  });

  it('does not declare app-local external-session host adapter bridges', () => {
    expect(AGENT_DEFINITION).not.toHaveProperty('externalSessionHostAdapters');
  });

  it('does not ship named static Codex models because Codex model truth is dynamic', () => {
    expect(AGENT_DEFINITION.modelConfig).toMatchObject({
      supportsSelection: true,
      dynamicProbe: 'auto',
      defaultMode: 'default',
      allowedModes: ['default'],
    });
    expect(AGENT_DEFINITION.modelConfig.staticModels).toBeUndefined();
  });
});
