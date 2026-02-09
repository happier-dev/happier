import { describe, expect, it } from 'vitest';

import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@/backends/claude/sdk';
import { convertSDKToLog } from './sdkToLogConverter';
import { createConverter, conversionContext } from './sdkToLogConverter.testkit';

describe('SDKToLogConverter relationships and helpers', () => {
  describe('Sidechain user message helper', () => {
    it('sets sidechainId on synthetic sidechain root messages', () => {
      const converter = createConverter();
      const logMessage = converter.convertSidechainUserMessage('tool_task_1', 'Do the thing');
      expect(logMessage.type).toBe('user');
      expect(logMessage.isSidechain).toBe(true);
      expect(logMessage.sidechainId).toBe('tool_task_1');
    });
  });

  describe('Parent-child relationships', () => {
    it('tracks parent UUIDs across messages', () => {
      const converter = createConverter();
      const msg1: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: 'First' },
      };
      const msg2: SDKAssistantMessage = {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Second' }] },
      };
      const msg3: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: 'Third' },
      };

      const log1 = converter.convert(msg1);
      const log2 = converter.convert(msg2);
      const log3 = converter.convert(msg3);

      expect(log1?.parentUuid).toBeNull();
      expect(log2?.parentUuid).toBe(log1?.uuid);
      expect(log3?.parentUuid).toBe(log2?.uuid);
    });

    it('resets parent chain when requested', () => {
      const converter = createConverter();
      const msg1: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: 'First' },
      };
      const log1 = converter.convert(msg1);

      converter.resetParentChain();

      const msg2: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: 'Second' },
      };
      const log2 = converter.convert(msg2);

      expect(log1).toBeTruthy();
      expect(log2?.parentUuid).toBeNull();
    });
  });

  describe('Batch conversion', () => {
    it('converts multiple messages while maintaining relationships', () => {
      const converter = createConverter();
      const messages: SDKMessage[] = [
        {
          type: 'user',
          message: { role: 'user', content: 'Hello' },
        } as SDKUserMessage,
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
        } as SDKAssistantMessage,
        {
          type: 'user',
          message: { role: 'user', content: 'How are you?' },
        } as SDKUserMessage,
      ];

      const logMessages = converter.convertMany(messages);

      expect(logMessages).toHaveLength(3);
      expect(logMessages[0]?.parentUuid).toBeNull();
      expect(logMessages[1]?.parentUuid).toBe(logMessages[0]?.uuid);
      expect(logMessages[2]?.parentUuid).toBe(logMessages[1]?.uuid);
    });
  });

  describe('Convenience function', () => {
    it('converts a single message without state', () => {
      const sdkMessage: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: 'Test message' },
      };

      const logMessage = convertSDKToLog(sdkMessage, conversionContext);

      expect(logMessage).toBeTruthy();
      expect(logMessage?.type).toBe('user');
      expect(logMessage?.parentUuid).toBeNull();
    });
  });
});
