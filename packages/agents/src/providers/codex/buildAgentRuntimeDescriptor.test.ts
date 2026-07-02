import { describe, expect, it } from 'vitest';

import { buildCodexAgentRuntimeDescriptor } from './buildAgentRuntimeDescriptor.js';
import {
  readCodexSessionMetadataConnectedServiceBindings,
  readCodexSessionMetadataRuntimeDescriptor,
} from './readSessionMetadataRuntimeDescriptor.js';

describe('buildCodexAgentRuntimeDescriptor', () => {
  it('preserves connected-service group affinity in the descriptor contract', () => {
    type ParamsWithGroup = Parameters<typeof buildCodexAgentRuntimeDescriptor>[0] & {
      connectedServiceGroupId: string;
    };

    const descriptor = buildCodexAgentRuntimeDescriptor({
      backendMode: 'appServer',
      providerSessionId: 'thread_1',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceGroupId: 'team',
      homePath: '/tmp/connected/__groups/team/codex/codex-home',
    } satisfies ParamsWithGroup);

    expect(descriptor.provider).toMatchObject({
      connectedServiceGroupId: 'team',
      providerExtra: {
        runtimeHandle: {
          connectedServiceGroupId: 'team',
        },
      },
    });

    expect(readCodexSessionMetadataRuntimeDescriptor({
      agentRuntimeDescriptorV1: descriptor,
    })).toMatchObject({
      connectedServiceGroupId: 'team',
      runtimeHandle: expect.objectContaining({
        connectedServiceGroupId: 'team',
      }),
    });
    expect(readCodexSessionMetadataConnectedServiceBindings({
      agentRuntimeDescriptorV1: descriptor,
    })).toEqual({
      'openai-codex': {
        source: 'connected',
        selection: 'group',
        groupId: 'team',
      },
    });
  });
});
