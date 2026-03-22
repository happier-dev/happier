import { describe, expect, it } from 'vitest';

import { captureConsoleText } from '@/testkit/logger/captureOutput';

describe('handleSessionCommand help output', () => {
  it('lists the direct session run control subcommands', async () => {
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleText();

    try {
      await handleSessionCommand(['--help']);

      expect(output.text()).toContain('happier session run start <session-id> --intent <intent> --backend <backend-target> [--json]');
      expect(output.text()).toContain('happier session run send <session-id> <run-id> <message> [--resume] [--json]');
      expect(output.text()).toContain('happier session run stop <session-id> <run-id> [--json]');
      expect(output.text()).toContain('happier session run action <session-id> <run-id> <action-id> [--input-json <json>] [--json]');
      expect(output.text()).toContain('happier session run wait <session-id> <run-id> [--timeout <seconds>] [--json]');
    } finally {
      output.restore();
    }
  });
});
