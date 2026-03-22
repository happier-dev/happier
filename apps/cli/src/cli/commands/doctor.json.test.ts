import { describe, expect, it, vi } from 'vitest';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const { runDoctorCommandMock, buildDoctorSnapshotMock } = vi.hoisted(() => ({
  runDoctorCommandMock: vi.fn<(..._args: unknown[]) => Promise<void>>(async () => {}),
  buildDoctorSnapshotMock: vi.fn(async () => ({
    capturedAt: '2026-02-23T00:00:00.000Z',
    server: {
      activeServerId: 'cloud',
      serverUrl: 'https://api.happier.dev',
      publicServerUrl: 'https://api.happier.dev',
      webappUrl: 'https://app.happier.dev',
    },
    accountId: 'acct_123',
    settings: {
      activeServerId: 'cloud',
      servers: [
        {
          id: 'cloud',
          name: 'Happier Cloud',
          serverUrl: 'https://api.happier.dev',
          webappUrl: 'https://app.happier.dev',
          createdAt: 0,
          updatedAt: 0,
          lastUsedAt: 0,
        },
      ],
      knownAccountIds: ['acct_123'],
    },
  })),
}));

vi.mock('@/ui/doctor', () => ({
  runDoctorCommand: (...args: unknown[]) => runDoctorCommandMock(...args),
}));

vi.mock('@/ui/doctorSnapshot', () => ({
  buildDoctorSnapshot: () => buildDoctorSnapshotMock(),
}));

import { handleDoctorCliCommand } from './doctor';

describe('happier doctor --json', () => {
  it('prints a single redacted JSON snapshot and does not run the human doctor output', async () => {
    const output = captureConsoleJsonOutput<{ server?: { serverUrl?: string }; accountId?: string }>();

    try {
      await handleDoctorCliCommand({
        args: ['doctor', '--json'],
        rawArgv: ['node', 'happier', 'doctor', '--json'],
        terminalRuntime: null,
      });

      expect(runDoctorCommandMock).not.toHaveBeenCalled();
      expect(output.logs).toHaveLength(1);
      const parsed = output.json();
      expect(parsed.accountId).toBe('acct_123');
      expect(parsed.server?.serverUrl).toBe('https://api.happier.dev');
    } finally {
      output.restore();
    }
  });
});
