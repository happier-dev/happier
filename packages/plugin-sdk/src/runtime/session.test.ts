import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as runtimeSession from './session.js';
import {
  isNonSteerablePromptPayload,
  parseSpecialCommand,
  resolveTerminalPromptProviderAcceptanceTimeoutMs,
  type SessionTerminalComposerClearResultV1,
} from './session.js';

const runtimeSessionSource = readFileSync(new URL('./session.ts', import.meta.url), 'utf8');

describe('public runtime/session helpers', () => {
  it('publishes terminal prompt steerability helpers through the SDK runtime session surface', () => {
    expect(parseSpecialCommand('/compact\nsummarize this session').type).toBe('compact');
    expect(isNonSteerablePromptPayload('/clear')).toBe(true);
    expect(isNonSteerablePromptPayload('/compact summarize this session')).toBe(true);
    expect(isNonSteerablePromptPayload('/model')).toBe(false);
  });

  it('publishes terminal composer clear result typing through the SDK runtime session surface', () => {
    const result = {
      ok: false,
      status: 'unsupported',
      sessionId: 'session-1',
      errorCode: 'unsupported_session_runtime_method',
    } satisfies SessionTerminalComposerClearResultV1;

    expect(result.status).toBe('unsupported');
  });

  it('publishes provider-acceptance timeout sizing through the SDK runtime session surface', () => {
    expect(resolveTerminalPromptProviderAcceptanceTimeoutMs('hello')).toBe(5_000);
    expect(resolveTerminalPromptProviderAcceptanceTimeoutMs('x'.repeat(128_000))).toBeGreaterThan(5_000);
    expect(resolveTerminalPromptProviderAcceptanceTimeoutMs('short', { bytesWritten: 128_000 })).toBeGreaterThan(5_000);
    expect(resolveTerminalPromptProviderAcceptanceTimeoutMs('x'.repeat(5_000_000))).toBe(180_000);
  });

  it('does not publish Codex backend-mode helpers through the generic SDK runtime session surface', () => {
    const codexBackendModeExports = [
      'CodexBackendMode',
      'normalizeCodexBackendMode',
      'resolveCodexSessionBackendMode',
    ] as const;

    for (const exportName of codexBackendModeExports) {
      expect(exportName in runtimeSession).toBe(false);
      expect(runtimeSessionSource).not.toMatch(new RegExp(`\\b${exportName}\\b`, 'u'));
    }
  });
});
