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

    it('does not emit log messages for synthetic partial assistant updates', () => {
      const sdkMessage: SDKAssistantMessage = {
        type: 'assistant',
        happierPartial: true,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'partial' }],
        },
      };

      expect(converter.convert(sdkMessage)).toBeNull();
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
    it('does not convert result messages', () => {
      const sdkMessage: SDKResultMessage = {
        type: 'result',
        subtype: 'success',
        result: 'Task completed',
        num_turns: 5,
        usage: {
          input_tokens: 100,
          output_tokens: 200,
        },
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
});
