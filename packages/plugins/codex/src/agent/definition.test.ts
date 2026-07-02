import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';

describe('AGENT_DEFINITION', () => {
  it('uses final agent CLI runtime vocabulary instead of legacy provider runtime vocabulary', () => {
    expect(AGENT_DEFINITION.agentCliRuntime).toEqual(expect.objectContaining({
      id: 'codex',
    }));
    const legacyRuntimeKey = 'provider' + 'CliRuntime';
    expect(legacyRuntimeKey in AGENT_DEFINITION).toBe(false);
  });

  it('declares the Codex provider runtime contribution export for bundled projection', () => {
    expect(AGENT_DEFINITION.runtimeContributions).toEqual({
      providerCatalogEntry: {
        importName: 'CODEX_PROVIDER_RUNTIME_CONTRIBUTION',
        source: './agent/contributions/runtime',
      },
      sessionControlAdapter: {
        kind: 'providerSessionControlAdapter',
        providerId: 'codex',
        source: './agent/surfaces/sessions/controls/adapter',
        exportName: 'CODEX_SESSION_CONTROL_ADAPTER',
      },
      runtimeDescriptorReader: {
        kind: 'providerRuntimeDescriptorReader',
        providerId: 'codex',
        source: './agent/identity/runtimeDescriptor',
        exportName: 'readCodexSessionMetadataRuntimeDescriptor',
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
      protocolExternalSessionSource: {
        kind: 'providerExternalSessionSourceV1',
        providerId: 'codex',
        source: './protocol/externalSession',
        exportName: 'CODEX_EXTERNAL_SESSION_SOURCE',
      },
      externalSessionHostAdapters: {
        kind: 'providerExternalSessionHostAdaptersV1',
        providerId: 'codex',
        candidateHostAdapter: {
          source: '@/backends/codex/appServer/session/externalCandidates',
          exportName: 'createCodexExternalSessionCandidateHostAdapter',
        },
        transcriptStoreAdapter: {
          source: '@/backends/codex/rollout/sessionStore/externalTranscriptAdapter',
          exportName: 'createCodexExternalSessionTranscriptStoreAdapter',
        },
      },
    });
  });
});
