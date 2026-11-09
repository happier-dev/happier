import { afterEach, describe, expect, it } from 'vitest';

import { preloadTranslationsForSettings, setPreferredLanguageFromSettings } from '@/text';

import { formatPermissionRequest, summarizeAgentRequestForVoiceHuman } from './contextFormatters';
import { getVoiceContextFormatterPrefs } from './voiceContextPrefs';

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
  afterEach(() => setPreferredLanguageFromSettings(null));

  it('localizes human-spoken request framing without changing authored question text', async () => {
    await preloadTranslationsForSettings('es');
    setPreferredLanguageFromSettings('es');
    const permission = summarizeAgentRequestForVoiceHuman('permission', 'req_es', 'Bash', { command: 'pwd' }, SHARE_ALL);
    const question = summarizeAgentRequestForVoiceHuman('user_action', 'req_question_es', 'ask_user_question', {
      questions: [{ question: 'Keep this exact authored question?', options: [{ label: 'Yes' }] }],
    }, SHARE_ALL);

    expect(permission).toContain('La sesión de código necesita permiso');
    expect(question).toContain('La sesión de código necesita tu respuesta');
    expect(question).toContain('Keep this exact authored question?');
  });
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

  it.each([true, false])('uses the current preference for request guidance before using more tools (enabled=%s)', (canApproveRequests) => {
    const result = formatPermissionRequest(
      'sess_4',
      'req_4',
      'Bash',
      { command: 'rm -rf /tmp/x' },
      { ...SHARE_ALL, ...getVoiceContextFormatterPrefs({ settings: { voice: { canApproveRequests } } }) },
    );

    expect(result).toContain('Interrupt your previous plan and tell the human about this request now.');
    expect(result).toContain(canApproveRequests ? 'Voice approvals are enabled' : 'Voice approvals are off');
    expect(result).toContain('Native Codex Realtime cannot decide requests');
    if (canApproveRequests) expect(result).toContain('Use the canonical request tools to approve or deny');
    else expect(result).toContain('A tap in the request UI is required');
    expect(result).toContain('Never claim it was settled until canonical session updates show the result.');
  });

  it('describes a terminal permission in plain words without reading shell input aloud', () => {
    const result = summarizeAgentRequestForVoiceHuman(
      'permission',
      'req_4',
      'Bash',
      { command: '/bin/bash -lc "printf secrets > /tmp/x"' },
      SHARE_ALL,
    );

    expect(result).toContain('needs permission');
    expect(result).toContain('terminal command');
    expect(result).not.toContain('printf');
    expect(result).not.toContain('/bin/bash');
    expect(result).not.toContain('req_4');
  });

  it('names the requesting Session only when Session summary sharing permits it', () => {
    const summarize = (share: boolean) => summarizeAgentRequestForVoiceHuman('permission', 'req_named', 'Bash',
      { command: 'pwd' }, { ...SHARE_ALL, voiceShareSessionSummary: share }, 'Morning Coffee');
    expect(summarize(true)).toContain('Morning Coffee');
    expect(summarize(false)).not.toContain('Morning Coffee');
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
