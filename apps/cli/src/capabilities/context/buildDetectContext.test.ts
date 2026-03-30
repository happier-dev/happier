import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DetectCliEntry, DetectCliSnapshot } from '../snapshots/cliSnapshot';
import type { CapabilityDetectRequest } from '../types';

function makeUnavailableCliEntry(): DetectCliEntry {
  return { available: false };
}

function makeDetectCliSnapshot(): DetectCliSnapshot {
  return {
    path: '/usr/bin',
    clis: {
      claude: makeUnavailableCliEntry(),
      codex: makeUnavailableCliEntry(),
      opencode: makeUnavailableCliEntry(),
      gemini: makeUnavailableCliEntry(),
      auggie: makeUnavailableCliEntry(),
      qwen: makeUnavailableCliEntry(),
      kimi: makeUnavailableCliEntry(),
      kilo: makeUnavailableCliEntry(),
      kiro: makeUnavailableCliEntry(),
      customAcp: makeUnavailableCliEntry(),
      pi: makeUnavailableCliEntry(),
      copilot: makeUnavailableCliEntry(),
    },
    tmux: { available: false },
    windowsTerminal: { available: false },
  };
}

describe('buildDetectContext', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('forwards bypassCache from tool.executionRuns requests', async () => {
    const mockDetectCliSnapshot = vi.fn().mockResolvedValue(makeDetectCliSnapshot());

    vi.doMock('../snapshots/cliSnapshot', () => ({
      detectCliSnapshotOnDaemonPath: mockDetectCliSnapshot,
    }));

    const { buildDetectContext } = await import('./buildDetectContext');

    const requests: CapabilityDetectRequest[] = [
      { id: 'tool.executionRuns', params: { bypassCache: true } },
    ];

    await buildDetectContext(requests);

    expect(mockDetectCliSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ bypassCache: true }),
    );
  });

  it('forwards bypassCache from cli.* requests', async () => {
    const mockDetectCliSnapshot = vi.fn().mockResolvedValue(makeDetectCliSnapshot());

    vi.doMock('../snapshots/cliSnapshot', () => ({
      detectCliSnapshotOnDaemonPath: mockDetectCliSnapshot,
    }));

    const { buildDetectContext } = await import('./buildDetectContext');

    const requests: CapabilityDetectRequest[] = [
      { id: 'cli.claude', params: { bypassCache: true } },
    ];

    await buildDetectContext(requests);

    expect(mockDetectCliSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ bypassCache: true }),
    );
  });

  it('does not bypass cache when no request has bypassCache', async () => {
    const mockDetectCliSnapshot = vi.fn().mockResolvedValue(makeDetectCliSnapshot());

    vi.doMock('../snapshots/cliSnapshot', () => ({
      detectCliSnapshotOnDaemonPath: mockDetectCliSnapshot,
    }));

    const { buildDetectContext } = await import('./buildDetectContext');

    const requests: CapabilityDetectRequest[] = [
      { id: 'tool.executionRuns' },
      { id: 'cli.claude' },
    ];

    await buildDetectContext(requests);

    expect(mockDetectCliSnapshot).toHaveBeenCalledWith(
      expect.not.objectContaining({ bypassCache: true }),
    );
  });

  it('bypasses cache when any request has bypassCache', async () => {
    const mockDetectCliSnapshot = vi.fn().mockResolvedValue(makeDetectCliSnapshot());

    vi.doMock('../snapshots/cliSnapshot', () => ({
      detectCliSnapshotOnDaemonPath: mockDetectCliSnapshot,
    }));

    const { buildDetectContext } = await import('./buildDetectContext');

    const requests: CapabilityDetectRequest[] = [
      { id: 'tool.executionRuns' },
      { id: 'cli.claude', params: { bypassCache: true } },
    ];

    await buildDetectContext(requests);

    expect(mockDetectCliSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ bypassCache: true }),
    );
  });

  it('forwards the requested CLI names for provider-scoped cli checks', async () => {
    const mockDetectCliSnapshot = vi.fn().mockResolvedValue(makeDetectCliSnapshot());

    vi.doMock('../snapshots/cliSnapshot', () => ({
      detectCliSnapshotOnDaemonPath: mockDetectCliSnapshot,
    }));

    const { buildDetectContext } = await import('./buildDetectContext');

    const requests: CapabilityDetectRequest[] = [
      { id: 'cli.codex', params: { includeLoginStatus: true } },
    ];

    await buildDetectContext(requests);

    expect(mockDetectCliSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        includeLoginStatus: true,
        requestedCliNames: ['codex'],
      }),
    );
  });
});
