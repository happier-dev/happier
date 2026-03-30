import { describe, expect, it, vi } from 'vitest';

import { updateSessionAgentStateWithAck, updateSessionMetadataWithAck } from './stateUpdates';
import { logger } from '@/ui/logger';

describe('stateUpdates (plaintext sessions)', () => {
  it('sends + applies plaintext metadata updates when session encryption mode is plain', async () => {
    const emitWithAck = vi.fn(async (_event: string, payload: any) => {
      expect(typeof payload.metadata).toBe('string');
      expect(payload.metadata).toContain('"path":"');
      return {
        result: 'success',
        metadata: payload.metadata,
        version: payload.expectedVersion + 1,
      };
    });

    const socket = { emitWithAck };

    let metadata: any = { path: '/tmp', host: 'localhost' };
    let version = 1;

    await updateSessionMetadataWithAck({
      socket,
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getMetadata: () => metadata,
      setMetadata: (next) => {
        metadata = next;
      },
      getMetadataVersion: () => version,
      setMetadataVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => ({ ...current, path: '/tmp2' }),
    });

    expect(metadata.path).toBe('/tmp2');
    expect(version).toBe(2);
  });

  it('logs currentModeId from the canonical sessionModesV1 metadata key', async () => {
    const emitWithAck = vi.fn(async (_event: string, payload: any) => ({
      result: 'success',
      metadata: payload.metadata,
      version: payload.expectedVersion + 1,
    }));

    const socket = { emitWithAck };
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    let metadata: any = { path: '/tmp', host: 'localhost' };
    let version = 1;

    await updateSessionMetadataWithAck({
      socket,
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getMetadata: () => metadata,
      setMetadata: (next) => {
        metadata = next;
      },
      getMetadataVersion: () => version,
      setMetadataVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: (current) => ({
        ...current,
        sessionModesV1: {
          v: 1,
          provider: 'codex',
          updatedAt: 1,
          currentModeId: 'plan',
          availableModes: [{ id: 'plan', name: 'Plan' }],
        },
      }),
    });

    expect(debugSpy).toHaveBeenCalledWith(
      '[API] updateMetadata attempting',
      expect.objectContaining({ currentModeId: 'plan' }),
    );
    expect(debugSpy).toHaveBeenCalledWith(
      '[API] updateMetadata success',
      expect.objectContaining({ currentModeId: 'plan' }),
    );

    debugSpy.mockRestore();
  });

  it('sends projected request counts with update-state payloads', async () => {
    const emitWithAck = vi.fn(async (_event: string, payload: any) => {
      expect(payload.activitySummaryV1).toEqual({
        pendingPermissionRequestCount: 1,
        pendingUserActionRequestCount: 1,
      });
      return {
        result: 'success',
        agentState: payload.agentState,
        version: payload.expectedVersion + 1,
      };
    });

    const socket = { emitWithAck };

    let agentState: any = { requests: {}, completedRequests: {} };
    let version = 1;

    await updateSessionAgentStateWithAck({
      socket,
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getAgentState: () => agentState,
      setAgentState: (next) => {
        agentState = next;
      },
      getAgentStateVersion: () => version,
      setAgentStateVersion: (next) => {
        version = next;
      },
      syncSessionSnapshotFromServer: async () => {},
      handler: () => ({
        requests: {
          req_permission: {
            tool: 'Write',
            arguments: { path: '/tmp/a.ts' },
            createdAt: 1,
          },
          req_action: {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            arguments: { question: 'Ship it?' },
            createdAt: 2,
          },
          req_completed: {
            tool: 'Write',
            arguments: { path: '/tmp/b.ts' },
            createdAt: 3,
          },
        },
        completedRequests: {
          req_completed: {
            tool: 'Write',
            arguments: { path: '/tmp/b.ts' },
            createdAt: 3,
            status: 'approved',
            completedAt: 4,
          },
        },
      }),
    });

    expect(agentState.requests.req_permission.tool).toBe('Write');
    expect(version).toBe(2);
  });
});
