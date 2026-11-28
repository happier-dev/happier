import { describe, expect, it } from 'vitest';

import { deriveLinkFromHostedMetadata } from '../index.js';
import { buildCodexAgentRuntimeDescriptor } from './agentRuntimeDescriptor.js';

describe('deriveLinkFromHostedMetadata', () => {
  it('recovers only providers with an existing transcript source and uses the current machine', () => {
    expect(deriveLinkFromHostedMetadata({ machineId: 'm1', claudeSessionId: 'claude-1' })).toEqual({
      v: 1, machineId: 'm1', providerId: 'claude', remoteSessionId: 'claude-1',
      source: { kind: 'claudeConfig' },
    });
    expect(deriveLinkFromHostedMetadata({ machineId: 'm1', opencodeSessionId: 'open-1', path: '/repo' })).toMatchObject({
      providerId: 'opencode', remoteSessionId: 'open-1',
      source: { kind: 'opencodeServer', directory: '/repo' },
    });
    expect(deriveLinkFromHostedMetadata({ machineId: 'm1', piSessionId: 'pi-1' })).toMatchObject({
      providerId: 'pi', remoteSessionId: 'pi-1', source: { kind: 'piAgentDir' },
    });
    expect(deriveLinkFromHostedMetadata({ machineId: 'm1', flavor: 'cursor', cursorSessionId: 'cursor-1' })).toBeNull();
    expect(deriveLinkFromHostedMetadata({ machineId: 'm1', flavor: 'claude' })).toBeNull();
    expect(deriveLinkFromHostedMetadata({ claudeSessionId: 'claude-1' })).toBeNull();
  });

  it('preserves connected Codex affinity and prefers its runtime identifier', () => {
    expect(deriveLinkFromHostedMetadata({
      machineId: 'machine',
      codexSessionId: 'old-id',
      agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
        backendMode: 'appServer', vendorSessionId: 'runtime-id', home: 'connectedService',
        homePath: '/connected/codex', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work',
      }),
    })).toMatchObject({
      providerId: 'codex', remoteSessionId: 'runtime-id', codexBackendMode: 'appServer',
      source: {
        kind: 'codexHome', home: 'connectedService', homePath: '/connected/codex',
        connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work',
      },
    });
  });
});
