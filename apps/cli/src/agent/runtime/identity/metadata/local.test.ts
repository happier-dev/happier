import { describe, expect, it } from 'vitest';

import {
  cloneSessionRuntimeLocalMetadata,
  pickSessionRuntimeLocalMetadata,
} from './local';

describe('Session runtime-local metadata', () => {
  it('keeps the canonical descriptor and linked Session while cloning nested owner data', () => {
    const metadata = {
      runtimeDescriptorV1: {
        v: 1 as const,
        agentId: 'acme.agent',
        agent: { providerSessionId: 'native-1', mode: 'cloud' },
      },
      externalSessionV1: {
        v: 1 as const,
        agentId: 'acme.agent',
        machineId: 'machine-1',
        remoteSessionId: 'native-1',
        source: { kind: 'acmeCloud', region: 'eu' },
        linkedAtMs: 1,
      },
    };

    const picked = pickSessionRuntimeLocalMetadata(metadata);
    const cloned = cloneSessionRuntimeLocalMetadata(picked!);

    expect(cloned).toEqual(metadata);
    expect(cloned).not.toBe(picked);
    expect(cloned.runtimeDescriptorV1).not.toBe(picked?.runtimeDescriptorV1);
    expect(cloned.runtimeDescriptorV1?.agent).not.toBe(picked?.runtimeDescriptorV1?.agent);
    expect(cloned.externalSessionV1).not.toBe(picked?.externalSessionV1);
    expect(cloned.externalSessionV1?.source).not.toBe(picked?.externalSessionV1?.source);
  });

  it('retains released flat Agent session ids as stored-data compatibility readers', () => {
    expect(pickSessionRuntimeLocalMetadata({
      claudeSessionId: 'claude-1',
      codexSessionId: 'codex-1',
      opencodeSessionId: 'opencode-1',
    })).toEqual({
      claudeSessionId: 'claude-1',
      codexSessionId: 'codex-1',
      opencodeSessionId: 'opencode-1',
    });
  });

  it('does not admit malformed descriptor or unrelated metadata into the local carrier', () => {
    expect(pickSessionRuntimeLocalMetadata({
      runtimeDescriptorV1: { v: 1, agentId: '', agent: {} },
      machineId: 'machine-private',
      environmentVariables: { TOKEN: 'secret' },
    })).toBeUndefined();
  });
});
