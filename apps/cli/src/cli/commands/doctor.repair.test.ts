import { describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const {
  runDoctorCommandMock,
  buildDoctorSnapshotMock,
  buildHappierRuntimeRepairPlanMock,
  applyHappierRuntimeRepairPlanMock,
} = vi.hoisted(() => ({
  runDoctorCommandMock: vi.fn(async () => {}),
  buildDoctorSnapshotMock: vi.fn(async () => ({
    capturedAt: '2026-02-23T00:00:00.000Z',
    server: {
      activeServerId: 'cloud',
      serverUrl: 'https://api.happier.dev',
      publicServerUrl: 'https://api.happier.dev',
      webappUrl: 'https://app.happier.dev',
    },
    settings: {
      activeServerId: 'cloud',
      servers: [],
      knownAccountIds: [],
    },
  })),
  buildHappierRuntimeRepairPlanMock: vi.fn(() => ({
    actions: [{ kind: 'restart-daemon', command: 'happier daemon restart' }],
    manualWarnings: [],
  })),
  applyHappierRuntimeRepairPlanMock: vi.fn(async () => ({
    executedActions: [{ kind: 'restart-daemon' }],
  })),
}));

vi.mock('@/ui/doctor', () => ({
  runDoctorCommand: runDoctorCommandMock,
}));

vi.mock('@/ui/doctorSnapshot', () => ({
  buildDoctorSnapshot: () => buildDoctorSnapshotMock(),
}));

vi.mock('@/diagnostics/happierRuntimeRepair', () => ({
  buildHappierRuntimeRepairPlan: buildHappierRuntimeRepairPlanMock,
  applyHappierRuntimeRepairPlan: applyHappierRuntimeRepairPlanMock,
}));

import { handleDoctorCliCommand } from './doctor';

describe('happier doctor repair', () => {
  it('prints a dry-run repair plan by default', async () => {
    const output = captureConsoleJsonOutput<{ ok: boolean; executed: boolean; actions: Array<{ kind: string }> }>();
    try {
      await handleDoctorCliCommand({
        args: ['doctor', 'repair', '--json'],
        rawArgv: ['node', 'happier', 'doctor', 'repair', '--json'],
        terminalRuntime: null,
      });

      expect(buildDoctorSnapshotMock).toHaveBeenCalled();
      expect(buildHappierRuntimeRepairPlanMock).toHaveBeenCalled();
      expect(applyHappierRuntimeRepairPlanMock).not.toHaveBeenCalled();
      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        executed: false,
        actions: [expect.objectContaining({ kind: 'restart-daemon' })],
      }));
    } finally {
      output.restore();
    }
  });

  it('executes the repair plan when --yes is provided', async () => {
    const output = captureConsoleJsonOutput<{ ok: boolean; executed: boolean; executedActions: Array<{ kind: string }> }>();
    try {
      await handleDoctorCliCommand({
        args: ['doctor', 'repair', '--yes', '--json'],
        rawArgv: ['node', 'happier', 'doctor', 'repair', '--yes', '--json'],
        terminalRuntime: null,
      });

      expect(applyHappierRuntimeRepairPlanMock).toHaveBeenCalled();
      expect(runDoctorCommandMock).not.toHaveBeenCalled();
      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        executed: true,
        executedActions: [expect.objectContaining({ kind: 'restart-daemon' })],
      }));
    } finally {
      output.restore();
    }
  });
});
