import { describe, expect, it } from 'vitest';

import {
  readCodexExecutionRunPreferredTransport,
  resolveCodexExecutionRunTransport,
} from './transport.js';

describe('resolveCodexExecutionRunTransport', () => {
  it('maps retired MCP transport requests to app-server', () => {
    expect(resolveCodexExecutionRunTransport({
      preferredTransport: 'mcp',
      start: {
        intent: 'voice_agent',
        retentionPolicy: 'resumable',
      },
    })).toBe('appServer');
  });

  it('keeps ACP as the explicit non-app-server transport', () => {
    expect(resolveCodexExecutionRunTransport({
      preferredTransport: 'acp',
      start: {
        intent: 'delegate',
        retentionPolicy: 'ephemeral',
      },
    })).toBe('acp');
  });

  it('defaults execution runs to app-server after MCP primary retirement', () => {
    expect(resolveCodexExecutionRunTransport({
      start: {
        intent: 'delegate',
        retentionPolicy: 'ephemeral',
      },
    })).toBe('appServer');
  });

  it('reads execution-run transport override from env before runtime extras', () => {
    expect(readCodexExecutionRunPreferredTransport({
      env: {
        HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT: 'acp',
      },
      runtimeExtras: {
        codexBackendMode: 'appServer',
      },
    })).toBe('acp');

    expect(readCodexExecutionRunPreferredTransport({
      env: {},
      runtimeExtras: {
        codexBackendMode: 'mcp',
      },
    })).toBe('mcp');
  });
});
