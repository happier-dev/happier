import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentState, Metadata } from '@/api/types';
import { updateAgentStateBestEffort, updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import { logger } from '@/ui/logger';

describe('sessionWritesBestEffort', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not throw when updateMetadata throws synchronously', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const session = {
      updateMetadata: () => {
        throw new Error('sync metadata error');
      },
    } satisfies Readonly<{ updateMetadata: (updater: (metadata: Metadata) => Metadata) => void }>;

    expect(() =>
      updateMetadataBestEffort(session, (m) => m, '[Test]', 'sync_throw'),
    ).not.toThrow();

    expect(debugSpy).toHaveBeenCalled();
  });

  it('does not throw when updateAgentState throws synchronously', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const session = {
      updateAgentState: () => {
        throw new Error('sync agent state error');
      },
    } satisfies Readonly<{ updateAgentState: (updater: (state: AgentState) => AgentState) => void }>;

    expect(() =>
      updateAgentStateBestEffort(session, (s) => s, '[Test]', 'sync_throw'),
    ).not.toThrow();

    expect(debugSpy).toHaveBeenCalled();
  });

  it('redacts synchronous metadata update errors before logging', () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const session = {
      updateMetadata: (_updater: (metadata: Metadata) => Metadata) => {
        throw new Error(
          'metadata failed for https://alice:SUPER_SECRET_PASSWORD@api.example.test/v1/session?token=secret Authorization: Bearer METADATA_SECRET',
        );
      },
    };

    updateMetadataBestEffort(session, (metadata) => metadata, '[Test]', 'redaction');

    const loggedError = debugSpy.mock.calls[0]?.[1];
    expect(loggedError).toEqual({
      name: 'Error',
      message: 'metadata failed for https://api.example.test/v1/session Authorization: <redacted>',
    });
    expect(JSON.stringify(loggedError)).not.toContain('SUPER_SECRET_PASSWORD');
    expect(JSON.stringify(loggedError)).not.toContain('METADATA_SECRET');
  });

  it('redacts asynchronous agent state update errors before logging', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const session = {
      updateAgentState: (_updater: (state: AgentState) => AgentState) => Promise.reject(new Error(
        'agent state failed for https://alice:SUPER_SECRET_PASSWORD@api.example.test/v1/state?token=secret Authorization: Bearer AGENT_STATE_SECRET',
      )),
    };

    updateAgentStateBestEffort(session, (state) => state, '[Test]', 'redaction');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const loggedError = debugSpy.mock.calls[0]?.[1];
    expect(loggedError).toEqual({
      name: 'Error',
      message: 'agent state failed for https://api.example.test/v1/state Authorization: <redacted>',
    });
    expect(JSON.stringify(loggedError)).not.toContain('SUPER_SECRET_PASSWORD');
    expect(JSON.stringify(loggedError)).not.toContain('AGENT_STATE_SECRET');
  });
});
