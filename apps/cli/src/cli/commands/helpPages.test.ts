import { describe, expect, it, vi } from 'vitest';

import { captureConsoleText } from '@/testkit/logger/captureOutput';

import { showAuthHelp } from './auth/help';
import { showMachineHelp } from './machine/help';
import { showRelayHelp } from './relay/help';
import { handleAgentsCommand } from './agents';

describe('CLI help output standardization', () => {
  it('renders auth, machine, relay, and agents help pages with shared structure', async () => {
    const output = captureConsoleText();
    try {
      showAuthHelp();
      showMachineHelp();
      showRelayHelp();
      await handleAgentsCommand(['help']);

      const text = output.text();
      expect(text).toContain('happier auth');
      expect(text).toContain('Usage:');
      expect(text).toContain('Options:');
      expect(text).toContain('happier machine');
      expect(text).toContain('Set up remote machines');
      expect(text).toContain('happier relay');
      expect(text).toContain('--ssh-user <user>');
      expect(text).toContain('--ssh-host <host>');
      expect(text).toContain('happier relay access status');
      expect(text).toContain('--ssh-auth agent|keyfile|password');
      expect(text).toContain('--upstream-url <url>');
      expect(text).toContain('happier agents');
      expect(text).toContain('Agent CLI helpers');
    } finally {
      output.restore();
    }
  });
});
