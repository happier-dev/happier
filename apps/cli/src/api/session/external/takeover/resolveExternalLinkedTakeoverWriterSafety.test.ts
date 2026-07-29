import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMocks = vi.hoisted(() => ({
  resolveExecutionSurfaces: vi.fn(),
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    resolveExecutionSurfaces: bridgeMocks.resolveExecutionSurfaces,
  }),
}));

import {
  resolveExternalLinkedTakeoverWriterSafety,
} from './resolveExternalLinkedTakeoverWriterSafety';

describe('external-linked takeover writer-safety resolution', () => {
  beforeEach(() => {
    bridgeMocks.resolveExecutionSurfaces.mockReset();
  });

  it('returns explicit current Agent native-prevention evidence', async () => {
    const writerSafety = 'native_prevention' as const;
    bridgeMocks.resolveExecutionSurfaces.mockResolvedValue({
      externalSession: { externalLinkedTakeoverWriterSafety: writerSafety },
    });

    await expect(resolveExternalLinkedTakeoverWriterSafety('opencode')).resolves.toBe(writerSafety);
  });

  it('fails closed when the current surface carries no disposition', async () => {
    bridgeMocks.resolveExecutionSurfaces.mockResolvedValue({
      externalSession: {},
    });

    await expect(resolveExternalLinkedTakeoverWriterSafety('opencode')).resolves.toBe('unsupported');
  });
});
