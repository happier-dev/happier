import { describe, expect, it } from 'vitest';

import { AGENTS_CORE } from './manifest';

describe('AGENTS_CORE cloudConnect status', () => {
  it('marks codex and claude connect targets as wired', () => {
    expect(AGENTS_CORE.codex.cloudConnect?.status).toBe('wired');
    expect(AGENTS_CORE.claude.cloudConnect?.status).toBe('wired');
  });

  it('exposes OpenAI API key connected service compatibility for codex/opencode/pi', () => {
    expect(AGENTS_CORE.codex.connectedServices?.supportedServiceIds).toContain('openai');
    expect(AGENTS_CORE.opencode.connectedServices?.supportedServiceIds).toContain('openai');
    expect(AGENTS_CORE.pi.connectedServices?.supportedServiceIds).toContain('openai');
  });
});
