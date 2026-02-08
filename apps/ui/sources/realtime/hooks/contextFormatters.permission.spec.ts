import { describe, expect, it } from 'vitest';
import { formatPermissionRequest } from './contextFormatters';

describe('formatPermissionRequest', () => {
  it('always redacts tool args for privacy', () => {
    const result = formatPermissionRequest('sess_1', 'req_1', 'execute', { secret: 'shh', path: '/tmp/a' });
    expect(result).toContain('<tool_name>execute</tool_name>');
    expect(result).toContain('<request_id>req_1</request_id>');
    expect(result).toContain('session sess_1');
    expect(result).not.toContain('shh');
    expect(result).not.toContain('/tmp/a');
    expect(result).not.toContain('<tool_args>');
  });

  it.each([
    { label: 'null args', args: null, leakedText: 'null' },
    { label: 'string args', args: 'SECRET=abc', leakedText: 'SECRET=abc' },
    { label: 'array args', args: ['token=abc', '/Users/alice/project'], leakedText: '/Users/alice/project' },
    { label: 'nested object args', args: { auth: { apiKey: 'sk-live' } }, leakedText: 'sk-live' },
  ])('keeps redaction stable for $label', ({ args, leakedText }) => {
    const result = formatPermissionRequest('sess_2', 'req_2', 'read', args);
    expect(result).toContain('<tool_args_redacted>true</tool_args_redacted>');
    expect(result).not.toContain(leakedText);
  });

  it('preserves request and tool identifiers while redacting args', () => {
    const result = formatPermissionRequest('sess-prod', 'req_99', 'search_files', {
      query: 'customer_password',
    });
    expect(result).toContain('<request_id>req_99</request_id>');
    expect(result).toContain('<tool_name>search_files</tool_name>');
    expect(result).not.toContain('customer_password');
  });
});
