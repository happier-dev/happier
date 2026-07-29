import { describe, expect, it } from 'vitest';

import type { CommandContext } from '@/cli/commandRegistry';
import { captureConsoleText } from '@/testkit/logger/captureOutput';
import {
  CLEAN_STATE_HEADER,
  MISMATCHED_STATE_HEADER,
} from './service/repair/prompts/_copy';
import { handleDoctorCliCommand } from './doctor';

function context(args: readonly string[]): CommandContext {
  return {
    args: [...args],
    rawArgv: ['node', 'happier', ...args],
    terminalRuntime: null,
  };
}

describe('happier doctor help', () => {
  it.each([
    ['--help'],
    ['-h'],
    ['help'],
  ])('renders top-level doctor help for `%s`', async (helpArg) => {
    const output = captureConsoleText();

    try {
      await handleDoctorCliCommand(context(['doctor', helpArg]));

      const text = output.text();
      expect(text).toContain('happier doctor');
      expect(text).toContain('System diagnostics and repair');
      expect(text).toContain('Usage:');
      expect(text).toContain('happier doctor repair');
    } finally {
      output.restore();
    }
  });

  it('keeps `doctor repair --help` on the repair command path', async () => {
    const output = captureConsoleText();

    try {
      await handleDoctorCliCommand(context(['doctor', 'repair', '--help']));

      const text = output.text();
      expect(text).not.toContain('System diagnostics and repair');
      expect(
        text.includes(CLEAN_STATE_HEADER) || text.includes(MISMATCHED_STATE_HEADER),
      ).toBe(true);
    } finally {
      output.restore();
    }
  });
});
