import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reattachTrackedSessionsFromMarkers } from './reattachFromMarkers';
import { findAllHappyProcesses } from '../doctor';
import { adoptSessionsFromMarkers } from '../reattach';
import { listSessionMarkers, removeSessionMarker } from '../sessionRegistry';

vi.mock('../doctor', () => ({
  findAllHappyProcesses: vi.fn(async () => []),
}));

vi.mock('../reattach', () => ({
  adoptSessionsFromMarkers: vi.fn(() => ({ adopted: 0, eligible: 0 })),
}));

vi.mock('../sessionRegistry', () => ({
  listSessionMarkers: vi.fn(async () => []),
  removeSessionMarker: vi.fn(async () => {}),
}));

describe('reattachTrackedSessionsFromMarkers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes dead markers and keeps a reattach-only contract', async () => {
    const marker = {
      pid: 43210,
      happySessionId: 'session-123',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash: 'a'.repeat(64),
    };

    vi.mocked(listSessionMarkers).mockResolvedValue([marker as any]);
    vi.mocked(findAllHappyProcesses).mockResolvedValue([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const pidToTrackedSession = new Map<number, any>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(result).toBeUndefined();
    expect(removeSessionMarker).toHaveBeenCalledWith(43210);
    expect(adoptSessionsFromMarkers).toHaveBeenCalledWith({
      markers: [],
      happyProcesses: [],
      pidToTrackedSession,
    });
  });
});
