import { beforeEach, describe, expect, it } from 'vitest';

import { SDKToLogConverter } from './sdkToLogConverter';
import type { SDKAssistantMessage, SDKResultMessage, SDKSystemMessage, SDKUserMessage } from '@/backends/claude/sdk';
import { asRecord, conversionContext } from './sdkToLogConverter.testkit';

describe('SDKToLogConverter core conversion', () => {
  let converter: SDKToLogConverter;

  beforeEach(() => {
    converter = new SDKToLogConverter(conversionContext);
  });

  describe('User messages', () => {
    it('converts SDK user message to log format', () => {
      const sdkMessage: SDKUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: 'Hello Claude',
        },
      };

      const logMessage = converter.convert(sdkMessage);

      expect(logMessage).toBeTruthy();
      expect(logMessage?.type).toBe('user');
      expect(logMessage).toMatchObject({
        type: 'user',
        sessionId: conversionContext.sessionId,
        cwd: conversionContext.cwd,
        version: conversionContext.version,
        gitBranch: conversionContext.gitBranch,
        parentUuid: null,
        isSidechain: false,
        userType: 'external',
        message: {
          role: 'user',
          content: 'Hello Claude',
        },
      });
      expect(logMessage?.uuid).toBeTruthy();
      expect(logMessage?.timestamp).toBeTruthy();
    });

    it('handles user message with complex content', () => {
      const sdkMessage: SDKUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Check this out' },
            { type: 'tool_result', tool_use_id: 'tool123', content: 'Result data' },
          ],
        },
      };

      const logMessage = converter.convert(sdkMessage);
      expect(logMessage?.type).toBe('user');

      if (!logMessage || logMessage.type !== 'user') {
        throw new Error('Expected user log message');
      }
      expect(Array.isArray(logMessage.message.content)).toBe(true);
      if (Array.isArray(logMessage.message.content)) {
        expect(logMessage.message.content).toHaveLength(2);
      }
    });
  });

  describe('Assistant messages', () => {
    it('converts SDK assistant message to log format', () => {
      const sdkMessage: SDKAssistantMessage = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello! How can I help?' }],
        },
      };

      const logMessage = converter.convert(sdkMessage);

      expect(logMessage).toBeTruthy();
      expect(logMessage?.type).toBe('assistant');
      expect(logMessage).toMatchObject({
        type: 'assistant',
        sessionId: conversionContext.sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello! How can I help?' }],
        },
      });
    });

    it('preserves SDK uuid when present so transcript dedupe remains stable', () => {
      const sdkMessage: SDKAssistantMessage = {
        type: 'assistant',
        uuid: 'sdk_uuid_1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'x' }],
        },
      } as any;

      const logMessage = converter.convert(sdkMessage);
      expect(logMessage?.uuid).toBe('sdk_uuid_1');
    });

    it('marks sidechain assistant messages with sidechainId', () => {
      const sdkMessage: SDKAssistantMessage = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Root' }],
        },
        parent_tool_use_id: 'tool123',
      };

      const logMessage = converter.convert(sdkMessage);

      expect(logMessage?.type).toBe('assistant');
      expect(logMessage?.isSidechain).toBe(true);
      const record = asRecord(logMessage);
      expect(record.sidechainId).toBe('tool123');
    });

    it('includes requestId when present', () => {
      const sdkMessage: SDKAssistantMessage = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Response' }],
        },
        requestId: 'req_123',
      };

      const logMessage = converter.convert(sdkMessage);
      const record = asRecord(logMessage);
      expect(record.requestId).toBe('req_123');
    });

    it('normalizes Claude Agent Teams tool_use names to canonical tool names', () => {
      const sdkMessage: SDKAssistantMessage = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'TeamCreate', input: {} }],
        },
      } as any;

      const logMessage = converter.convert(sdkMessage) as any;
      expect(logMessage?.type).toBe('assistant');
      const content = logMessage?.message?.content;
      expect(Array.isArray(content)).toBe(true);
      const toolUse = Array.isArray(content) ? content.find((c: any) => c?.type === 'tool_use') : null;
      expect(toolUse?.name).toBe('AgentTeamCreate');
    });
  });

  describe('System messages', () => {
    it('converts SDK system message to log format', () => {
      const sdkMessage: SDKSystemMessage = {
        type: 'system',
        subtype: 'init',
        session_id: 'new-session-456',
        model: 'claude-opus-4',
        cwd: '/project',
        tools: ['bash', 'edit'],
      };

      const logMessage = converter.convert(sdkMessage);

      expect(logMessage).toBeTruthy();
      expect(logMessage?.type).toBe('system');
      expect(logMessage).toMatchObject({
        type: 'system',
        subtype: 'init',
        model: 'claude-opus-4',
        tools: ['bash', 'edit'],
      });
    });

    it('updates session ID on init system message', () => {
      const sdkMessage: SDKSystemMessage = {
        type: 'system',
        subtype: 'init',
        session_id: 'updated-session-789',
      };

      converter.convert(sdkMessage);

      const userMessage: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: 'Test' },
      };

      const logMessage = converter.convert(userMessage);
      expect(logMessage?.sessionId).toBe('updated-session-789');
    });
  });

  describe('Result messages', () => {
    it('converts successful result usage into assistant usage telemetry with the runtime context window', () => {
      const sdkMessage: SDKResultMessage = {
        type: 'result',
        subtype: 'success',
        result: 'Task completed',
        num_turns: 5,
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_read_input_tokens: 50,
        },
        modelUsage: {
          'claude-opus-4-7': {
            inputTokens: 100,
            outputTokens: 200,
            cacheReadInputTokens: 50,
            contextWindow: 1_000_000,
          },
        },
        total_cost_usd: 0.05,
        duration_ms: 3000,
        duration_api_ms: 2500,
        is_error: false,
        session_id: 'result-session',
      };

      const logMessage = converter.convert(sdkMessage);

      expect(logMessage).toMatchObject({
        type: 'assistant',
        sessionId: conversionContext.sessionId,
        message: {
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [],
          usage: {
            input_tokens: 100,
            output_tokens: 200,
            cache_read_input_tokens: 50,
            context_window_tokens: 1_000_000,
          },
        },
      });
    });

    it('uses latest assistant input as result context usage instead of cumulative result usage', () => {
      const assistantWithActiveContext: SDKAssistantMessage & {
        message: SDKAssistantMessage['message'] & {
          model: string;
          usage: {
            input_tokens: number;
            cache_creation_input_tokens: number;
            cache_read_input_tokens: number;
            output_tokens: number;
          };
        };
      } = {
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'Working' }],
          usage: {
            input_tokens: 1,
            cache_creation_input_tokens: 111,
            cache_read_input_tokens: 938_731,
            output_tokens: 4_765,
          },
        },
      };
      converter.convert(assistantWithActiveContext);

      const logMessage = converter.convert({
        type: 'result',
        subtype: 'success',
        num_turns: 20,
        usage: {
          input_tokens: 4_000_000,
          output_tokens: 25_000,
          cache_creation_input_tokens: 769_000,
          cache_read_input_tokens: 39_231_000,
        },
        modelUsage: {
          'claude-opus-4-7': {
            contextWindow: 1_000_000,
          },
        },
        total_cost_usd: 100,
        duration_ms: 1000,
        duration_api_ms: 900,
        is_error: false,
        session_id: 'result-session',
      });

      expect(logMessage).toMatchObject({
        type: 'assistant',
        message: {
          usage: {
            context_used_tokens: 938_843,
            context_window_tokens: 1_000_000,
          },
        },
      });
    });

    it('does not use result usage telemetry as the next conversation parent', () => {
      converter.convert({
        type: 'assistant',
        uuid: 'assistant-before-result',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done' }],
        },
      } as SDKAssistantMessage);

      converter.convert({
        type: 'result',
        subtype: 'success',
        num_turns: 1,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
        },
        modelUsage: {
          'claude-opus-4-7': {
            contextWindow: 1_000_000,
          },
        },
        total_cost_usd: 0.01,
        duration_ms: 100,
        duration_api_ms: 90,
        is_error: false,
        session_id: 'result-session',
      });

      const nextUserMessage = converter.convert({
        type: 'user',
        message: {
          role: 'user',
          content: 'Next prompt',
        },
      } as SDKUserMessage);

      expect(nextUserMessage?.parentUuid).toBe('assistant-before-result');
    });

    it('does not convert result messages without usage telemetry', () => {
      const sdkMessage: SDKResultMessage = {
        type: 'result',
        subtype: 'success',
        result: 'Task completed',
        num_turns: 5,
        total_cost_usd: 0.05,
        duration_ms: 3000,
        duration_api_ms: 2500,
        is_error: false,
        session_id: 'result-session',
      };

      const logMessage = converter.convert(sdkMessage);
      expect(logMessage).toBeNull();
    });

    it('does not convert error results', () => {
      const sdkMessage: SDKResultMessage = {
        type: 'result',
        subtype: 'error_max_turns',
        num_turns: 10,
        total_cost_usd: 0.1,
        duration_ms: 5000,
        duration_api_ms: 4500,
        is_error: true,
        session_id: 'error-session',
      };

      const logMessage = converter.convert(sdkMessage);
      expect(logMessage).toBeFalsy();
    });
  });

  describe('Internal Claude events', () => {
    it('does not convert rate_limit_event messages (telemetry, not transcript content)', () => {
      const logMessage = converter.convert({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed' },
      } as any);

      expect(logMessage).toBeNull();
    });

    it.each([
      ['last-prompt', { type: 'last-prompt', lastPrompt: 'hi', leafUuid: 'leaf-1' }],
      ['mode', { type: 'mode', mode: 'default' }],
      ['pr-link', { type: 'pr-link', url: 'https://example.test/pr/1' }],
    ])('does not convert %s records (internal session state, not transcript content)', (_label, sdkMessage) => {
      // Boundary cast: these are raw internal SDK records outside the SDKMessage union by design.
      expect(converter.convert(sdkMessage as any)).toBeNull();
    });

    it('does not convert attachment records (context injection, not transcript content)', () => {
      // Boundary cast: raw attachment record shape is outside the typed SDKMessage union.
      const logMessage = converter.convert({
        type: 'attachment',
        attachment: { type: 'hook_success', hookEvent: 'SessionStart', stdout: '{}' },
      } as any);

      expect(logMessage).toBeNull();
    });
  });
});
