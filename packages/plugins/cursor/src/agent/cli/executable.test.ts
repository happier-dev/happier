import { describe, expect, it } from 'vitest';

import { resolveCursorAgentExecutable } from './executable.js';

describe('resolveCursorAgentExecutable', () => {
  it('prefers configured path before detected executables', () => {
    expect(resolveCursorAgentExecutable({
      configuredPath: '/opt/cursor-agent',
      detected: [
        { binaryName: 'cursor-agent', executablePath: '/usr/local/bin/cursor-agent', identifiesAsCursor: true },
      ],
    })).toEqual({
      status: 'resolved',
      binaryName: 'cursor-agent',
      executablePath: '/opt/cursor-agent',
      source: 'configured',
    });
  });

  it('prefers cursor-agent over agent when both identify as Cursor', () => {
    expect(resolveCursorAgentExecutable({
      configuredPath: null,
      detected: [
        { binaryName: 'agent', executablePath: '/usr/local/bin/agent', identifiesAsCursor: true },
        { binaryName: 'cursor-agent', executablePath: '/usr/local/bin/cursor-agent', identifiesAsCursor: true },
      ],
    })).toMatchObject({
      status: 'resolved',
      binaryName: 'cursor-agent',
      executablePath: '/usr/local/bin/cursor-agent',
      source: 'detected',
    });
  });

  it('accepts agent fallback only when identity proves Cursor', () => {
    expect(resolveCursorAgentExecutable({
      configuredPath: null,
      detected: [
        { binaryName: 'agent', executablePath: '/usr/local/bin/agent', identifiesAsCursor: false },
      ],
    })).toEqual({
      status: 'unresolved',
      reason: 'not_found',
    });
  });
});
