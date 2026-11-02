import { describe, expect, it } from 'vitest';

import { normalizeToolCallV2, normalizeToolResultV2 } from './index';
import { normalizeCodexSessionMessageBody } from '@/api/session/sessionOutboundMessageNormalization';

const result = (canonicalToolName: string, rawOutput: unknown) => normalizeToolResultV2({
  protocol: 'codex', provider: 'codex', rawToolName: canonicalToolName, canonicalToolName, rawOutput,
});

describe('normalized tool raw retention', () => {
  it('stores command output once through the outbound message owner', () => {
    const output = 'command output\n'.repeat(300);
    const normalized = normalizeCodexSessionMessageBody({
      body: { type: 'tool-call-result', callId: 'shell', output: { stdout: output, exit_code: 0 } },
      toolCallCanonicalNameByProviderAndId: new Map([['codex:shell', { rawToolName: 'Bash', canonicalToolName: 'Bash' }]]),
      debug: () => undefined,
    });
    expect(normalized.output).toMatchObject({ stdout: output, exit_code: 0 });
    expect(normalized.output).not.toHaveProperty('_raw');
    expect(JSON.stringify(normalized.output).split('command output').length - 1).toBe(300);
    expect(normalizeCodexSessionMessageBody({
      body: normalized,
      toolCallCanonicalNameByProviderAndId: new Map([['codex:shell', { rawToolName: 'Bash', canonicalToolName: 'Bash' }]]),
      debug: () => undefined,
    })).toEqual(normalized);
  });

  it('omits redundant input while preserving unknown-tool fields and non-string facts', () => {
    const input = { queryText: 'unique query', metadata: { enabled: false, attempts: 0, values: [null, true, 4] } };
    const normalized = normalizeToolCallV2({ protocol: 'codex', provider: 'codex', toolName: 'custom_tool', rawInput: input });
    expect(normalized.input).toMatchObject(input);
    expect(normalized.input).not.toHaveProperty('_raw');
    expect(result('custom_tool', { output: 'report', metadata: input.metadata })).toMatchObject({ output: 'report', metadata: input.metadata });
    expect(result('custom_tool', { output: 'report', metadata: input.metadata })).not.toHaveProperty('_raw');
  });

  it('retains only unique named metadata even when its value occurs in another field', () => {
    const normalized = result('Read', { output: 'file body', metadata: { loaded: false, other: false, attempts: 0 } });
    expect(normalized).toMatchObject({
      file: { content: 'file body' },
      metadata: { other: false, attempts: 0 },
      _raw: { metadata: { loaded: false } },
    });
    expect(normalized).not.toHaveProperty('_raw.output');
    expect(normalized).not.toHaveProperty('_raw.metadata.other');
  });

  it.each([
    ['Bash', { stdout: 'native command body', stderr: '', backgroundTaskId: 'native-task' }],
    ['SubAgent', { output: 'native report body', status: 'completed', agentId: 'native-agent' }],
  ])('keeps direct native %s output and task facts once', (toolName, native) => {
    const normalized = result(toolName, native);
    expect(normalized).toMatchObject(native);
    expect(normalized).not.toHaveProperty('_raw');
  });

  it('retains uniquely typed primitive and unknown-array data without inventing canonical fields', () => {
    expect(result('Bash', 42)).toMatchObject({ stdout: '42', _raw: 42 });
    expect(result('custom_tool', [false, 0, { detail: 'unique' }])).toMatchObject({ value: [false, 0, { detail: 'unique' }] });
    expect(result('custom_tool', [false, 0, { detail: 'unique' }])).not.toHaveProperty('_raw');
    expect(normalizeToolCallV2({ protocol: 'codex', provider: 'codex', toolName: 'custom_tool', rawInput: 42 }).input).toMatchObject({ _raw: 42 });
  });

  it('keeps existing raw bounds for unique data and canonical edit output for renderers', () => {
    const input = 'unique input'.repeat(300);
    const normalized = normalizeToolCallV2({ protocol: 'codex', provider: 'codex', toolName: 'custom_tool', rawInput: input });
    expect(normalized.input).toMatchObject({ _raw: input.slice(0, 2_000) + '…(truncated 1600 chars)' });
    const diff = '--- a/example\n+++ b/example\n@@ -1 +1 @@\n-before\n+after';
    expect(result('Edit', { output: diff, applied: true })).toMatchObject({ output: diff, applied: true });
    expect(result('Edit', { output: diff, applied: true })).not.toHaveProperty('_raw');
    expect(result('Edit', diff)).toMatchObject({ message: diff });
    expect(result('Edit', diff)).not.toHaveProperty('_raw');
  });
});
