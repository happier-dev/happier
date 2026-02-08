import { describe, expect, it } from 'vitest';
import { formatCodexEventForUi } from './formatCodexEventForUi';

describe('formatCodexEventForUi', () => {
  it.each([null, undefined, 42, 'error', ['error']])(
    'returns null for non-object input: %p',
    (value) => {
      expect(formatCodexEventForUi(value)).toBeNull();
    },
  );

  it('formats generic error events', () => {
    expect(formatCodexEventForUi({ type: 'error', message: 'bad' })).toBe('Codex error: bad');
  });

  it('falls back when generic error message is missing', () => {
    expect(formatCodexEventForUi({ type: 'error', message: '   ' })).toBe('Codex error');
  });

  it('formats stream errors', () => {
    expect(formatCodexEventForUi({ type: 'stream_error', message: 'oops' })).toBe('Codex stream error: oops');
  });

  it('falls back when stream error message is missing', () => {
    expect(formatCodexEventForUi({ type: 'stream_error', message: '' })).toBe('Codex stream error');
  });

  it('formats MCP startup failures', () => {
    expect(
      formatCodexEventForUi({
        type: 'mcp_startup_update',
        server: 'happy',
        status: { state: 'failed', error: 'nope' },
      }),
    ).toBe('MCP server "happy" failed to start: nope');
  });

  it('avoids redundant fallback text for MCP startup failures without an error string', () => {
    expect(
      formatCodexEventForUi({
        type: 'mcp_startup_update',
        status: { state: 'failed' },
      }),
    ).toBe('MCP server "unknown" failed to start: unknown error');
  });

  it('returns null for events that should not be shown', () => {
    expect(formatCodexEventForUi({ type: 'agent_message', message: 'hi' })).toBeNull();
  });

  it('returns null for MCP startup updates that are not failed', () => {
    expect(
      formatCodexEventForUi({
        type: 'mcp_startup_update',
        server: 'happy',
        status: { state: 'ok' },
      }),
    ).toBeNull();
  });
});
