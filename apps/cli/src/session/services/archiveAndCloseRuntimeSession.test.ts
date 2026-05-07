import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { createEnvKeyScope } from '@/testkit/env/envScope';

import { archiveAndCloseRuntimeSession } from './archiveAndCloseRuntimeSession';

type ArchiveAndCloseRuntimeSessionWithOptions = (
  session: {
    sessionId: string;
    updateMetadata: (updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => void;
    sendSessionDeath: () => void;
    flush: () => Promise<void>;
    close: () => Promise<void>;
  } | null | undefined,
  credentials?: { token: string },
  archiveReason?: string | null,
  options?: { timeoutMs?: number; pollIntervalMs?: number },
) => Promise<void>;

describe('archiveAndCloseRuntimeSession', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL'] as const;
  let envScope = createEnvKeyScope(envKeys);

  beforeEach(async () => {
    process.env.HAPPIER_SERVER_URL = 'http://127.0.0.1:4010';
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('closes the live session and then archives it through the canonical session archive route', async () => {
    const postSpy = vi.spyOn(axios, 'post');
    const getSpy = vi.spyOn(axios, 'get');

    postSpy
      .mockResolvedValueOnce({ status: 409, data: { error: 'session-active' } } as never)
      .mockResolvedValueOnce({ status: 200, data: { success: true, archivedAt: 1234 } } as never);

    getSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-runtime-1',
          seq: 1,
          createdAt: 1,
          updatedAt: 2,
          active: true,
          activeAt: 2,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          pendingCount: 0,
          pendingVersion: 0,
          dataEncryptionKey: null,
          share: null,
          archivedAt: null,
        },
      },
    } as never);

    let updatedMetadata: Record<string, unknown> | null = null;
    const session = {
      sessionId: 'sess-runtime-1',
      updateMetadata: vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
        updatedMetadata = updater({ path: '/tmp/workspace' });
      }),
      sendSessionDeath: vi.fn(),
      flush: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };

    const invokeArchiveAndCloseRuntimeSession =
      archiveAndCloseRuntimeSession as unknown as ArchiveAndCloseRuntimeSessionWithOptions;
    await invokeArchiveAndCloseRuntimeSession(session, { token: 'token-1' }, 'Killed by user', {
      timeoutMs: 50,
      pollIntervalMs: 0,
    });

    expect(updatedMetadata).toMatchObject({
      lifecycleState: 'archived',
      archivedBy: 'cli',
      archiveReason: 'Killed by user',
    });
    expect(session.sendSessionDeath).toHaveBeenCalledTimes(1);
    expect(session.flush).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(String(postSpy.mock.calls[1]?.[0])).toContain('/v2/sessions/sess-runtime-1/archive');
    expect(getSpy).toHaveBeenCalledTimes(1);

    const sendDeathOrder = session.sendSessionDeath.mock.invocationCallOrder[0] ?? 0;
    const flushOrder = session.flush.mock.invocationCallOrder[0] ?? 0;
    const closeOrder = session.close.mock.invocationCallOrder[0] ?? 0;
    const archiveOrder = postSpy.mock.invocationCallOrder[0] ?? 0;
    expect(sendDeathOrder).toBeLessThan(flushOrder);
    expect(flushOrder).toBeLessThan(closeOrder);
    expect(closeOrder).toBeLessThan(archiveOrder);
  });

  it('backs off before retrying archive when the session lookup is temporarily unavailable', async () => {
    const postSpy = vi.spyOn(axios, 'post');
    const getSpy = vi.spyOn(axios, 'get');

    postSpy
      .mockResolvedValueOnce({ status: 409, data: { error: 'session-active' } } as never)
      .mockResolvedValueOnce({ status: 200, data: { success: true, archivedAt: 1234 } } as never);

    getSpy.mockRejectedValueOnce(new Error('temporary_lookup_failure'));

    const session = {
      sessionId: 'sess-runtime-2',
      updateMetadata: vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => updater({})),
      sendSessionDeath: vi.fn(),
      flush: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };

    const invokeArchiveAndCloseRuntimeSession =
      archiveAndCloseRuntimeSession as unknown as ArchiveAndCloseRuntimeSessionWithOptions;
    const startedAt = Date.now();
    await invokeArchiveAndCloseRuntimeSession(session, { token: 'token-1' }, null, {
      timeoutMs: 250,
      pollIntervalMs: 25,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(elapsedMs).toBeGreaterThanOrEqual(20);
  });

  it('awaits lifecycle metadata persistence before closing the live session', async () => {
    const postSpy = vi.spyOn(axios, 'post');
    const getSpy = vi.spyOn(axios, 'get');
    postSpy.mockResolvedValue({ status: 200, data: { success: true, archivedAt: 1234 } } as never);
    getSpy.mockResolvedValue({
      status: 200,
      data: {
        session: {
          id: 'sess-runtime-await',
          active: false,
          archivedAt: 1234,
        },
      },
    } as never);

    let resolveMetadataUpdate!: () => void;
    const metadataUpdate = new Promise<void>((resolve) => {
      resolveMetadataUpdate = resolve;
    });
    const session = {
      sessionId: 'sess-runtime-await',
      updateMetadata: vi.fn(() => metadataUpdate),
      sendSessionDeath: vi.fn(),
      flush: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };

    const invokeArchiveAndCloseRuntimeSession =
      archiveAndCloseRuntimeSession as unknown as ArchiveAndCloseRuntimeSessionWithOptions;
    const pending = invokeArchiveAndCloseRuntimeSession(session, { token: 'token-1' }, null, {
      timeoutMs: 50,
      pollIntervalMs: 0,
    });

    await Promise.resolve();
    expect(session.updateMetadata).toHaveBeenCalledTimes(1);
    expect(session.sendSessionDeath).not.toHaveBeenCalled();

    resolveMetadataUpdate();
    await pending;

    expect(session.sendSessionDeath).toHaveBeenCalledTimes(1);
    expect(session.updateMetadata.mock.invocationCallOrder[0]).toBeLessThan(session.sendSessionDeath.mock.invocationCallOrder[0]);
  });
});
