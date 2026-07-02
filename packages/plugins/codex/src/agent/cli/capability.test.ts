import { describe, expect, it } from 'vitest';

import {
  buildCodexCliAcpCapabilitySnapshot,
  codexCliCapabilityDescriptor,
  shouldIncludeCodexAcpCapabilities,
} from './capability.js';

describe('Codex CLI capability policy', () => {
  it('declares the provider-owned base CLI capability descriptor', () => {
    expect(codexCliCapabilityDescriptor).toEqual({
      id: 'cli.codex',
      kind: 'cli',
      title: 'Codex CLI',
    });
  });

  it('reads the ACP capability probe flag without treating missing params as enabled', () => {
    expect(shouldIncludeCodexAcpCapabilities(null)).toBe(false);
    expect(shouldIncludeCodexAcpCapabilities({})).toBe(false);
    expect(shouldIncludeCodexAcpCapabilities({ includeAcpCapabilities: false })).toBe(false);
    expect(shouldIncludeCodexAcpCapabilities({ includeAcpCapabilities: true })).toBe(true);
  });

  it('projects Codex ACP load-session probe success into the CLI capability payload', () => {
    expect(
      buildCodexCliAcpCapabilitySnapshot({
        ok: true,
        checkedAt: 123,
        loadSession: true,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: {},
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false },
        },
      }),
    ).toEqual({
      ok: true,
      checkedAt: 123,
      loadSession: true,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {},
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
    });
  });

  it('projects Codex ACP load-session probe failures without leaking host error details', () => {
    expect(
      buildCodexCliAcpCapabilitySnapshot({
        ok: false,
        checkedAt: 456,
        error: { message: 'probe failed' },
      }),
    ).toEqual({
      ok: false,
      checkedAt: 456,
      error: { message: 'probe failed' },
    });
  });
});
