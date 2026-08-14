import { describe, expect, it } from 'vitest';

import * as runtimeDescriptor from './runtimeDescriptor.js';

const {
  buildAntigravityRuntimeDescriptorV1,
  readCanonicalAntigravityRuntimeDescriptorV1,
} = runtimeDescriptor;

describe('Antigravity runtime descriptor', () => {
  it('builds and reads concrete runtime mode and cliPrint conversation affinity', () => {
    const descriptor = buildAntigravityRuntimeDescriptorV1({
      runtimeMode: 'cliPrint',
      providerSessionId: 'agy-conversation-1',
      agyConversationId: 'agy-conversation-1',
      home: 'user',
    });

    expect(descriptor).toEqual({
      v: 1,
      agentId: 'antigravity',
      agent: {
        runtimeMode: 'cliPrint',
        providerSessionId: 'agy-conversation-1',
        agyConversationId: 'agy-conversation-1',
        home: 'user',
        agentExtra: {
          owner: 'antigravity',
          schemaId: 'antigravity.agentRuntimeDescriptorExtra',
          v: 1,
          runtimeHandle: {
            runtimeMode: 'cliPrint',
            providerSessionId: 'agy-conversation-1',
            agyConversationId: 'agy-conversation-1',
            home: 'user',
          },
        },
      },
    });
    expect(readCanonicalAntigravityRuntimeDescriptorV1(descriptor)).toEqual({
      agentId: 'antigravity',
      runtimeMode: 'cliPrint',
      providerSessionId: 'agy-conversation-1',
      agyConversationId: 'agy-conversation-1',
      localharnessSessionId: null,
      home: 'user',
      connectedServiceId: null,
      connectedServiceProfileId: null,
      connectedServiceGroupId: null,
    });
  });

  it('reads SDK localharness identity from providerExtra runtimeHandle when the top-level provider is sparse', () => {
    expect(readCanonicalAntigravityRuntimeDescriptorV1({
      v: 1,
      agentId: 'antigravity',
      agent: {
        agentExtra: {
          owner: 'antigravity',
          schemaId: 'antigravity.agentRuntimeDescriptorExtra',
          v: 1,
          runtimeHandle: {
            runtimeMode: 'sdk',
            localharnessSessionId: 'lh-session-1',
          },
        },
      },
    })).toMatchObject({
      runtimeMode: 'sdk',
      providerSessionId: 'lh-session-1',
      localharnessSessionId: 'lh-session-1',
    });
  });

  it('prefers providerExtra runtimeHandle over stale top-level provider fields', () => {
    expect(readCanonicalAntigravityRuntimeDescriptorV1({
      v: 1,
      agentId: 'antigravity',
      agent: {
        runtimeMode: 'cliPrint',
        agyConversationId: 'stale-cli-conversation',
        agentExtra: {
          owner: 'antigravity',
          schemaId: 'antigravity.agentRuntimeDescriptorExtra',
          v: 1,
          runtimeHandle: {
            runtimeMode: 'sdk',
            localharnessSessionId: 'fresh-localharness-session',
          },
        },
      },
    })).toMatchObject({
      runtimeMode: 'sdk',
      providerSessionId: 'fresh-localharness-session',
      agyConversationId: 'stale-cli-conversation',
      localharnessSessionId: 'fresh-localharness-session',
    });
  });

  it('does not expose a plugin-local raw metadata compatibility reader', () => {
    expect(runtimeDescriptor).not.toHaveProperty('readAntigravitySessionMetadataRuntimeDescriptor');
  });

  it('leaves legacy generic carrier normalization to the host compatibility owner', () => {
    expect(readCanonicalAntigravityRuntimeDescriptorV1({
      v: 1,
      providerId: 'antigravity',
      provider: { runtimeMode: 'sdk' },
    })).toBeNull();
  });

  it('fails closed when canonical and deployed identity fields conflict', () => {
    expect(readCanonicalAntigravityRuntimeDescriptorV1({
      v: 1,
      agentId: 'antigravity',
      providerId: 'codex',
      agent: { runtimeMode: 'sdk' },
    })).toBeNull();
  });
});
