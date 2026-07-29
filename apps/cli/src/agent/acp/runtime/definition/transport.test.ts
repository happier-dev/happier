import { describe, expect, it } from 'vitest';

import { buildAcpToolNameResolverInput } from '@/agent/acp/toolCalls';

import { createAcpTransportHandlerFromDefinition } from './transport';

describe('ACP definition transport tool-name inference', () => {
  it('prefers a provider title hint over a generic input-field identity', () => {
    const transport = createAcpTransportHandlerFromDefinition({
      backendId: 'acme.provider',
      toolNameInference: {
        patterns: [{
          name: 'change_title',
          patterns: ['change_title'],
          inputFields: ['title'],
        }, {
          name: 'read',
          patterns: ['read', 'read_file'],
          inputFields: ['path'],
        }],
        unknownToolNames: ['other'],
        hintInputFields: ['title'],
        preferLongestPattern: true,
      },
    });

    const inferenceInput = buildAcpToolNameResolverInput({
      target_file: '/workspace/README.md',
    }, 'read_file');

    expect(transport.determineToolName?.('other', 'opaque-call-id', inferenceInput, {
      recentPromptHadChangeTitle: false,
      toolCallCountSincePrompt: 1,
    })).toBe('read');
  });

  it('prefers a command input over additive ACP title metadata', () => {
    const transport = createAcpTransportHandlerFromDefinition({
      backendId: 'acme.provider',
      toolNameInference: {
        patterns: [{
          name: 'change_title',
          patterns: ['change_title'],
          inputFields: ['title'],
        }, {
          name: 'bash',
          patterns: ['bash', 'execute'],
          inputFields: ['command', 'cmd'],
        }],
        unknownToolNames: ['other'],
        hintInputFields: ['title', 'description'],
        preferLongestPattern: true,
      },
    });

    expect(transport.determineToolName?.('other', 'opaque-call-id', {
      command: 'echo TRACE_OK',
      description: 'Echo trace marker',
      title: 'run_terminal_command',
      _acp: { title: 'run_terminal_command' },
    }, {
      recentPromptHadChangeTitle: false,
      toolCallCountSincePrompt: 2,
    })).toBe('bash');
  });

  it('does not treat provider observation titles as change-title input', () => {
    const transport = createAcpTransportHandlerFromDefinition({
      backendId: 'acme.provider',
      toolNameInference: {
        patterns: [{
          name: 'change_title',
          patterns: ['change_title'],
          inputFields: ['title'],
        }, {
          name: 'bash',
          patterns: ['bash', 'execute_command'],
          inputFields: ['command', 'cmd'],
        }],
        unknownToolNames: ['other'],
        hintInputFields: ['title', 'description'],
        preferLongestPattern: true,
      },
    });

    const inferenceInput = buildAcpToolNameResolverInput(
      { task_ids: ['call-1'], timeout_ms: 60_000 },
      'get_command_or_subagent_output',
    );

    expect(transport.determineToolName?.('other', 'opaque-call-id', inferenceInput, {
      recentPromptHadChangeTitle: false,
      toolCallCountSincePrompt: 2,
    })).toBe('other');
  });
});
