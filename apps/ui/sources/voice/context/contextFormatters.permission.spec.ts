import { describe, expect, it } from 'vitest';

import { formatPermissionRequest } from './contextFormatters';

describe('formatPermissionRequest (opt-out defaults)', () => {
  it('includes tool args by default', () => {
    const result = formatPermissionRequest('sess_1', 'req_1', 'execute', { secret: 'shh', path: '/tmp/a' });
    expect(result).toContain('<tool_name>execute</tool_name>');
    expect(result).toContain('<request_id>req_1</request_id>');
    expect(result).toContain('session sess_1');
    expect(result).toContain('<tool_args>');
    expect(result).toContain('shh');
    expect(result).toContain('/tmp/a');
    expect(result).not.toContain('<tool_args_redacted>');
  });

  it.each([
    { label: 'null args', args: null, leakedText: 'null' },
    { label: 'string args', args: 'SECRET=abc', leakedText: 'SECRET=abc' },
    { label: 'array args', args: ['token=abc', '/Users/alice/project'], leakedText: '/Users/alice/project' },
    { label: 'nested object args', args: { auth: { apiKey: 'sk-live' } }, leakedText: 'sk-live' },
  ])('redacts args when voiceShareToolArgs is false for $label', ({ args, leakedText }) => {
    const result = formatPermissionRequest('sess_2', 'req_2', 'read', args, { voiceShareToolArgs: false });
    expect(result).toContain('<tool_args_redacted>true</tool_args_redacted>');
    expect(result).not.toContain('<tool_args>');
    expect(result).not.toContain(leakedText);
  });

  it('redacts file paths inside args when voiceShareFilePaths is false', () => {
    const result = formatPermissionRequest(
      'sess_3',
      'req_3',
      'read',
      { path: '/Users/alice/SecretRepo/README.md' },
      { voiceShareToolArgs: true, voiceShareFilePaths: false },
    );
    expect(result).toContain('<tool_args>');
    expect(result).toContain('<path_redacted>');
    expect(result).not.toContain('/Users/alice/SecretRepo/README.md');
  });
});
