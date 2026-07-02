import { describe, expect, it } from 'vitest';

import {
  CLAUDE_REMOTE_PROVIDER_FIELDS,
  CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFINITION,
  CLAUDE_UNIFIED_TERMINAL_HOSTS,
} from './claudeRemote.js';

describe('Claude unified terminal settings fields', () => {
  it('exports the canonical unified terminal host values used by the provider schema', () => {
    expect(CLAUDE_UNIFIED_TERMINAL_HOSTS).toEqual(['auto', 'tmux', 'zellij']);
    expect(CLAUDE_REMOTE_PROVIDER_FIELDS.claudeUnifiedTerminalHost.schema.options).toEqual(
      CLAUDE_UNIFIED_TERMINAL_HOSTS,
    );
  });
});

describe('CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFINITION', () => {
  it('stays descriptor-only and does not carry outgoing message-meta shaping', () => {
    expect(CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFINITION).toMatchObject({
      providerId: 'claude',
      fields: expect.any(Object),
    });
    expect('buildOutgoingMessageMetaExtras' in CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFINITION).toBe(false);
  });
});
