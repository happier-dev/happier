import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import { reattachTrackedSessionsFromMarkers } from './reattachFromMarkers';
import { findAllHappyProcesses } from '../doctor';
import { adoptSessionsFromMarkers } from '../reattach';
import { listSessionMarkers, removeSessionMarker, writeSessionMarker } from '../sessionRegistry';

vi.mock('../doctor', () => ({
  findAllHappyProcesses: vi.fn(async () => []),
}));

vi.mock('../reattach', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../reattach')>();
  return {
    ...actual,
    adoptSessionsFromMarkers: vi.fn(() => ({ adopted: 0, eligible: 0 })),
  };
});

vi.mock('../sessionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sessionRegistry')>();
  return {
    ...actual,
    listSessionMarkers: vi.fn(async () => []),
    removeSessionMarker: vi.fn(async () => {}),
    writeSessionMarker: vi.fn(async () => {}),
  };
});

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

  it('recovers live daemon-spawned sessions without markers and heals the marker', async () => {
    const command = `${process.execPath} -e "setInterval(()=>{}, 1000)"`;
    const processCommandHash = createHash('sha256').update(command).digest('hex');

    vi.mocked(listSessionMarkers).mockResolvedValue([]);
    vi.mocked(findAllHappyProcesses).mockResolvedValue([
      { pid: 54321, command, type: 'daemon-spawned-session' } as any,
    ]);

    const pidToTrackedSession = new Map<number, any>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(result).toBeUndefined();
    expect(pidToTrackedSession.get(54321)).toMatchObject({
      pid: 54321,
      startedBy: 'daemon',
      happySessionId: 'PID-54321',
      processCommandHash,
    });
    expect(writeSessionMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: 54321,
        happySessionId: 'PID-54321',
        startedBy: 'daemon',
        processCommandHash,
        processCommand: command,
      }),
    );
  });
});
