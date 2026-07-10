import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';

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

  it('uses final agent CLI runtime vocabulary instead of legacy provider runtime vocabulary', () => {
    expect(AGENT_DEFINITION.agentCliRuntime).toEqual(expect.objectContaining({
      id: 'codex',
    }));
    const legacyRuntimeKey = 'provider' + 'CliRuntime';
    expect(legacyRuntimeKey in AGENT_DEFINITION).toBe(false);
  });

  it('declares the Codex agent runtime contribution export for bundled projection', () => {
    expect(AGENT_DEFINITION.runtimeContributions).toEqual({
      agentCatalogEntry: {
        importName: 'CODEX_AGENT_RUNTIME_CONTRIBUTION',
        source: './agent/contributions/runtime',
      },
      sessionControlAdapter: {
        kind: 'providerSessionControlAdapter',
        providerId: 'codex',
        source: './agent/surfaces/sessions/controls/adapter',
        exportName: 'CODEX_SESSION_CONTROL_ADAPTER',
        generatedAdapter: expect.objectContaining({
          providerId: 'codex',
          runtimeDescriptor: expect.objectContaining({ providerId: 'codex' }),
        }),
      },
      runtimeDescriptorReader: {
        kind: 'providerRuntimeDescriptorReader',
        providerId: 'codex',
        source: './agent/identity/runtimeDescriptor',
        exportName: 'readCodexSessionMetadataRuntimeDescriptor',
        generatedReader: expect.objectContaining({
          providerId: 'codex',
          backendModeKey: 'backendMode',
        }),
      },
      protocolRuntimeDescriptor: {
        kind: 'providerRuntimeDescriptorV1',
        providerId: 'codex',
        source: './protocol/runtimeDescriptorV1',
        buildFunction: 'buildCodexAgentRuntimeDescriptorV1',
        canonicalReader: 'readCanonicalCodexAgentRuntimeDescriptorV1',
      },
      protocolBuiltInBackendProfiles: {
        kind: 'providerBuiltInBackendProfilesV1',
        providerId: 'codex',
        source: './protocol/profiles',
        exportName: 'CODEX_BUILT_IN_BACKEND_PROFILES',
      },
    });
  });

  it('does not declare app-local external-session host adapter bridges', () => {
    expect(AGENT_DEFINITION.runtimeContributions).not.toHaveProperty('externalSessionHostAdapters');
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
