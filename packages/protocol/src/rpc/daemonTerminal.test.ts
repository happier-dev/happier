import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './index.js';

describe('RPC_METHODS (daemon terminal)', () => {
  it('includes daemon.terminal.ensure', () => {
    expect(RPC_METHODS.DAEMON_TERMINAL_ENSURE).toBe('daemon.terminal.ensure');
  });

  it('includes daemon.terminal.stream.read', () => {
    expect(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ).toBe('daemon.terminal.stream.read');
  });

  it('includes byte-stream daemon terminal methods', () => {
    expect(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES).toBe('daemon.terminal.stream.readBytes');
    expect(RPC_METHODS.DAEMON_TERMINAL_STREAM_ACK).toBe('daemon.terminal.stream.ack');
    expect(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT).toBe('daemon.terminal.stream.input');
  });

  it('includes daemon.terminal.input', () => {
    expect(RPC_METHODS.DAEMON_TERMINAL_INPUT).toBe('daemon.terminal.input');
  });

  it('includes daemon.terminal.resize', () => {
    expect(RPC_METHODS.DAEMON_TERMINAL_RESIZE).toBe('daemon.terminal.resize');
  });

  it('includes daemon.terminal.close', () => {
    expect(RPC_METHODS.DAEMON_TERMINAL_CLOSE).toBe('daemon.terminal.close');
  });

  it('includes daemon.terminal.restart', () => {
    expect(RPC_METHODS.DAEMON_TERMINAL_RESTART).toBe('daemon.terminal.restart');
  });
});
