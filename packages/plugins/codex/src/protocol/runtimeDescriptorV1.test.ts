import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  buildCodexAgentRuntimeDescriptorV1,
  readCanonicalCodexAgentRuntimeDescriptorV1,
} from './runtimeDescriptorV1.js';

describe('Codex runtime descriptor v1', () => {
  it('owns the provider codec inside the plugin leaf', () => {
    const source = readFileSync(new URL('./runtimeDescriptorV1.ts', import.meta.url), 'utf8');
    const protocolSpecifier = '@happier-dev/' + 'protocol';

    expect(source).not.toContain(`from '${protocolSpecifier}`);
    expect(source).not.toContain(`from "${protocolSpecifier}`);
  });

  it('keeps connected-service group descriptors canonical', () => {
    const descriptor = buildCodexAgentRuntimeDescriptorV1({
      backendMode: 'appServer',
      providerSessionId: ' thread-1 ',
      home: 'connectedService',
      connectedServiceId: ' openai-codex ',
      connectedServiceGroupId: ' team ',
      homePath: ' /tmp/connected/__groups/team/codex/codex-home ',
    });

    expect(readCanonicalCodexAgentRuntimeDescriptorV1(descriptor)).toEqual({
      agentId: 'codex',
      backendMode: 'appServer',
      providerSessionId: 'thread-1',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: null,
      connectedServiceGroupId: 'team',
      homePath: '/tmp/connected/__groups/team/codex/codex-home',
    });
  });

  it('keeps legacy runtimeAffinity provider-extra carriers readable', () => {
    expect(readCanonicalCodexAgentRuntimeDescriptorV1({
      v: 1,
      agentId: 'codex',
      provider: {
        backendMode: 'appServer',
        providerExtra: {
          owner: 'codex',
          schemaId: 'codex.agentRuntimeDescriptorExtra',
          v: 1,
          runtimeAffinity: {
            backendMode: 'acp',
            vendorSessionId: 'legacy-thread',
          },
        },
      },
    })).toMatchObject({
      backendMode: 'acp',
      providerSessionId: 'legacy-thread',
    });
  });

  it('ignores provider-extra carriers without the Codex owner and schema', () => {
    expect(readCanonicalCodexAgentRuntimeDescriptorV1({
      v: 1,
      agentId: 'codex',
      provider: {
        backendMode: 'appServer',
        providerSessionId: 'canonical-thread',
        providerExtra: {
          owner: 'other-provider',
          schemaId: 'other-provider.agentRuntimeDescriptorExtra',
          v: 1,
          runtimeHandle: {
            backendMode: 'acp',
            providerSessionId: 'forged-thread',
          },
        },
      },
    })).toMatchObject({
      backendMode: 'appServer',
      providerSessionId: 'canonical-thread',
    });
  });

  it('fails closed when canonical and deployed identity fields conflict', () => {
    expect(readCanonicalCodexAgentRuntimeDescriptorV1({
      v: 1,
      agentId: 'codex',
      providerId: 'opencode',
      provider: { backendMode: 'appServer' },
    })).toBeNull();
  });
});
