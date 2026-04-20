import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

const sessionRegistryMock = vi.hoisted(() => ({
  listSessionMarkers: vi.fn(),
  writeSessionMarker: vi.fn(),
}));

const doctorMock = vi.hoisted(() => ({
  findHappyProcessByPid: vi.fn(),
}));

vi.mock('../../../../daemon/sessionRegistry', async () => {
  const actual = await vi.importActual<typeof import('../../../../daemon/sessionRegistry')>('../../../../daemon/sessionRegistry');
  return {
    ...actual,
    listSessionMarkers: sessionRegistryMock.listSessionMarkers,
    writeSessionMarker: sessionRegistryMock.writeSessionMarker,
  };
});

vi.mock('../../../../daemon/doctor', () => ({
  findHappyProcessByPid: doctorMock.findHappyProcessByPid,
}));

import { hashProcessCommand } from '../../../../daemon/sessionRegistry';
import { createProviderSessionIdentityPublisher } from './providerSession';

describe('createProviderSessionIdentityPublisher', () => {
  it('strengthens a weak tracked-session marker with the live process command when publishing the provider session id', async () => {
    const processCommand =
      '/Users/test/.happier/cli-preview/current/happier claude --happy-starting-mode remote --started-by daemon';
    let metadata = createTestMetadata({
      path: '/tmp/project',
      flavor: 'claude',
      startedBy: 'daemon',
      hostPid: 12345,
    });

    sessionRegistryMock.listSessionMarkers.mockResolvedValue([
      {
        pid: 12345,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        metadata: createTestMetadata({
          path: '/tmp/project',
          flavor: 'claude',
          startedBy: 'daemon',
          hostPid: 12345,
        }),
      },
    ]);
    doctorMock.findHappyProcessByPid.mockResolvedValue({
      pid: 12345,
      command: processCommand,
    });

    const publisher = createProviderSessionIdentityPublisher({
      agentId: 'claude',
      session: {
        sessionId: 'session-123',
        getMetadataSnapshot: () => metadata,
        updateMetadata: async (updater: (current: Metadata) => Metadata) => {
          metadata = updater(metadata);
        },
      } as any,
      vendorResumeIdField: 'claudeSessionId',
      lastPublished: { value: null },
    });

    publisher('claude-session-1');
    await vi.waitFor(() => {
      expect(sessionRegistryMock.writeSessionMarker).toHaveBeenCalledWith({
        pid: 12345,
        happySessionId: 'session-123',
        flavor: 'claude',
        startedBy: 'daemon',
        cwd: '/tmp/project',
        processCommandHash: hashProcessCommand(processCommand),
        processCommand,
        metadata: expect.objectContaining({
          path: '/tmp/project',
          flavor: 'claude',
          startedBy: 'daemon',
          hostPid: 12345,
          claudeSessionId: 'claude-session-1',
        }),
      });
    });
  });
});
