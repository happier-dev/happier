import { afterEach, describe, expect, it, vi } from 'vitest';

const { handleServiceRepairCliCommandMock } = vi.hoisted(() => ({
  handleServiceRepairCliCommandMock: vi.fn(async () => undefined),
}));

vi.mock('./service/repair/handleServiceRepairCliCommand', () => ({
  handleServiceRepairCliCommand: handleServiceRepairCliCommandMock,
}));

import { handleStatusCliCommand } from './status';

describe('status command routing', () => {
  afterEach(() => {
    handleServiceRepairCliCommandMock.mockClear();
  });

  it('renders the doctor repair report in read-only mode', async () => {
    await handleStatusCliCommand({
      args: ['status', '--server', 'preview'],
      rawArgv: ['node', 'happier', 'status', '--server', 'preview'],
      terminalRuntime: null,
    });

    expect(handleServiceRepairCliCommandMock).toHaveBeenCalledWith({
      argv: ['repair', '--report-only', '--server', 'preview'],
      commandPath: 'happier status',
    });
  });

  it('rejects repair execution flags', async () => {
    await expect(handleStatusCliCommand({
      args: ['status', '--yes'],
      rawArgv: ['node', 'happier', 'status', '--yes'],
      terminalRuntime: null,
    })).rejects.toThrow('happier status is read-only');

    expect(handleServiceRepairCliCommandMock).not.toHaveBeenCalled();
  });
});
