import { describe, expect, it } from 'vitest';

import { formatPermissionRequest, summarizeAgentRequestForVoiceHuman } from './contextFormatters';

const SHARE_ALL = {
  voiceShareSessionSummary: true,
  voiceShareRecentMessages: true,
  voiceRecentMessagesCount: 10,
  voiceShareToolNames: true,
  voiceShareToolArgs: true,
  voiceShareFilePaths: true,
  voiceSharePermissionRequests: true,
  voiceShareDeviceInventory: true,
} as const;

describe('formatPermissionRequest privacy', () => {
  it('includes tool args when sharing is explicitly enabled', () => {
    const result = formatPermissionRequest(
      'sess_1',
      'req_1',
      'execute',
      { secret: 'shh', path: '/tmp/a' },
      SHARE_ALL,
    );
    expect(result).toContain('<tool_name>execute</tool_name>');
    expect(result).toContain('<request_id>req_1</request_id>');
    expect(result).not.toContain('sess_1');
    expect(result).toContain('Coding assistant is requesting permission');
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
    const result = formatPermissionRequest(
      'sess_2',
      'req_2',
      'read',
      args,
      { ...SHARE_ALL, voiceShareToolArgs: false },
    );
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
      { ...SHARE_ALL, voiceShareFilePaths: false },
    );
    expect(result).toContain('<tool_args>');
    expect(result).toContain('<path_redacted>');
    expect(result).not.toContain('/Users/alice/SecretRepo/README.md');
  });

  it('explicitly tells the voice agent to interrupt and wait for the user before using more tools', () => {
    const result = formatPermissionRequest(
      'sess_4',
      'req_4',
      'Bash',
      { command: 'rm -rf /tmp/x' },
      SHARE_ALL,
    );

    expect(result).toContain('Interrupt your previous plan and tell the human about this request now.');
    expect(result).toContain('Do not call any tools or send new coding-session work while this permission remains pending.');
    expect(result).toContain('Tell the human to use the canonical session UI to approve or deny it.');
    expect(result).toContain('A spoken answer does not decide this permission request.');
    expect(result).toContain('Never claim it was settled until canonical session updates show the result.');
  });

  it('creates a short human-facing permission summary for deterministic voice announcements', () => {
    const result = summarizeAgentRequestForVoiceHuman(
      'permission',
      'req_4',
      'Bash',
      { command: 'rm -rf /tmp/x' },
      SHARE_ALL,
    );

    expect(result).toContain('needs permission');
    expect(result).toContain('Run:');
    expect(result).toContain('Review it in the session UI to approve or deny.');
    expect(result).toContain('rm -rf /tmp/x');
    expect(result).not.toContain('req_4');
  });

  it('redacts file paths inside the human-facing permission summary when file path sharing is disabled', () => {
    const result = summarizeAgentRequestForVoiceHuman(
      'permission',
      'req_5',
      'write',
      { filepath: '/Users/alice/SecretRepo/src/private.ts' },
      { ...SHARE_ALL, voiceShareFilePaths: false },
    );

    expect(result).toContain('needs permission');
    expect(result).toContain('<path_redacted>');
    expect(result).not.toContain('/Users/alice/SecretRepo/src/private.ts');
  });
});
