import { describe, expect, it, vi } from 'vitest';

import { updateAgentStateBestEffort, updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import { logger } from '@/ui/logger';

describe('sessionWritesBestEffort', () => {
  it('does not throw when updateMetadata throws synchronously', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const session = {
      updateMetadata: () => {
        throw new Error('sync metadata error');
      },
    };

    expect(() =>
      updateMetadataBestEffort(session as any, (m) => m, '[Test]', 'sync_throw'),
    ).not.toThrow();

    expect(debugSpy).toHaveBeenCalled();
  });

  it('does not throw when updateAgentState throws synchronously', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const session = {
      updateAgentState: () => {
        throw new Error('sync agent state error');
      },
    };

    expect(() =>
      updateAgentStateBestEffort(session as any, (s) => s, '[Test]', 'sync_throw'),
    ).not.toThrow();

    expect(debugSpy).toHaveBeenCalled();
  });
});

