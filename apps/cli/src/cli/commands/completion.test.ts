import { describe, expect, it } from 'vitest';

import { captureStdout } from '@/testkit/logger/captureOutput';

import { handleCompletionCliCommand } from './completion';

describe('completion command', () => {
  it.each([
    ['bash', 'complete -F _happier_completion happier'],
    ['zsh', 'compdef _happier_completion happier'],
    ['fish', 'complete -c happier'],
    ['powershell', 'Register-ArgumentCompleter -Native -CommandName happier'],
  ] as const)('emits a pure %s completion script', async (shell, marker) => {
    const output = captureStdout();
    try {
      await handleCompletionCliCommand({
        args: ['completion', shell], rawArgv: ['happier', 'completion', shell], terminalRuntime: null,
      });
      expect(output.chunks).toHaveLength(1);
      expect(output.text()).toContain(marker);
      expect(output.text()).not.toContain('node ');
      expect(output.text()).not.toContain('npm ');
    } finally {
      output.restore();
    }
  });
});
