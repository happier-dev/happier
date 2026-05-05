import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  runDoctorCommandMock,
  handleServiceRepairCliCommandMock,
} = vi.hoisted(() => ({
  runDoctorCommandMock: vi.fn(async () => {}),
  handleServiceRepairCliCommandMock: vi.fn(async () => undefined),
}));

vi.mock('@/ui/doctor', () => ({
  runDoctorCommand: runDoctorCommandMock,
}));

vi.mock('./service/repair/handleServiceRepairCliCommand', () => ({
  handleServiceRepairCliCommand: handleServiceRepairCliCommandMock,
}));

import { handleDoctorCliCommand } from './doctor';

describe('happier doctor repair', () => {
  afterEach(() => {
    runDoctorCommandMock.mockReset();
    handleServiceRepairCliCommandMock.mockReset();
  });

  it('delegates doctor repair to the canonical service repair flow', async () => {
    await handleDoctorCliCommand({
      args: ['doctor', 'repair', '--json'],
      rawArgv: ['node', 'happier', 'doctor', 'repair', '--json'],
      terminalRuntime: null,
    });

    expect(handleServiceRepairCliCommandMock).toHaveBeenCalledWith({
      argv: ['repair', '--json'],
      commandPath: 'happier doctor',
    });
  });

  it('keeps non-repair doctor invocations on the doctor command path', async () => {
    await handleDoctorCliCommand({
      args: ['doctor'],
      rawArgv: ['node', 'happier', 'doctor'],
      terminalRuntime: null,
    });

    expect(runDoctorCommandMock).toHaveBeenCalled();
    expect(handleServiceRepairCliCommandMock).not.toHaveBeenCalled();
  });
});
