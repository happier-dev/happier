import { describe, expect, it } from 'vitest';

import { selectCodexExecutionRunTransport } from './selectCodexExecutionRunTransport';

describe('selectCodexExecutionRunTransport', () => {
  it('allows an explicit app-server execution-run transport opt-in for non-voice runs', () => {
    expect(selectCodexExecutionRunTransport({
      hasInteractiveTty: false,
      preferredTransport: 'appServer',
      start: {
        intent: 'delegate',
        retentionPolicy: 'ephemeral',
      },
    })).toBe('appServer');
  });

  it('prefers app-server for voice_agent runs by default', () => {
    expect(selectCodexExecutionRunTransport({
      hasInteractiveTty: false,
      start: {
        intent: 'voice_agent',
        retentionPolicy: 'resumable',
      },
    })).toBe('appServer');
  });

  it('prefers app-server for non-voice execution runs by default', () => {
    expect(selectCodexExecutionRunTransport({
      hasInteractiveTty: false,
      start: {
        intent: 'delegate',
        retentionPolicy: 'ephemeral',
      },
    })).toBe('appServer');
  });

  it('preserves explicit MCP overrides for voice_agent runs', () => {
    expect(selectCodexExecutionRunTransport({
      hasInteractiveTty: true,
      preferredTransport: 'mcp',
      start: {
        intent: 'voice_agent',
        retentionPolicy: 'resumable',
      },
    })).toBe('mcp');
  });
});
