import { describe, expect, it } from 'vitest';

import { createReducer, reducer } from '../reducer';
import type { NormalizedMessage } from '../../typesRaw';
import { normalizeThinkingChunk } from './thinkingText';

describe('thinkingText', () => {
  describe('normalizeThinkingChunk', () => {
    it('preserves markdown header-like bold lines (does not strip "**")', () => {
      const input = '**Ensuring correct file changes**\n\nI am thinking about next steps.';
      const normalized = normalizeThinkingChunk(input);
      expect(normalized).toContain('**Ensuring correct file changes**');
    });

    it('preserves list newlines (does not collapse markdown lists into one line)', () => {
      const input = '- first item\n- second item\n';
      const normalized = normalizeThinkingChunk(input);
      expect(normalized).toContain('\n- second item');
    });

    it('collapses word-per-line streams into spaces for readability', () => {
      const input = 'Hello\nworld\nfrom\ncodex\n';
      const normalized = normalizeThinkingChunk(input);
      expect(normalized).toBe('Hello world from codex ');
    });

    it('collapses single-token word-per-line deltas ending in "\\n" into a trailing space', () => {
      const input = 'Hello\n';
      const normalized = normalizeThinkingChunk(input);
      expect(normalized).toBe('Hello ');
    });

    it('does not collapse code-like punctuation lines into a single paragraph', () => {
      const input = 'constx=1;\nreturnx;\n';
      const normalized = normalizeThinkingChunk(input);
      expect(normalized).toBe(input);
    });
  });

  describe('reducer thinking merge', () => {
    it('merges long-running streamed thinking chunks even when createdAt spans more than 2 minutes', () => {
      const state = createReducer();

      const mkThinking = (id: string, createdAt: number, thinking: string): NormalizedMessage => ({
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'thinking', thinking, uuid: id, parentUUID: null }],
      });

      reducer(state, [mkThinking('t1', 1000, 'Now I')]);
      reducer(state, [mkThinking('t2', 1000 + 180_000, ' have a better understanding.')]);
      reducer(state, [mkThinking('t3', 1000 + 360_000, ' Let me continue executing more tools.')]);

      const thinkingMessages = [...state.messages.values()].filter(
        (m) => m.role === 'agent' && m.isThinking && typeof m.text === 'string',
      );
      expect(thinkingMessages).toHaveLength(1);
      expect(String(thinkingMessages[0]!.text)).toBe(
        'Now I have a better understanding. Let me continue executing more tools.',
      );
    });

    it('preserves leading spaces in streamed deltas', () => {
      const state = createReducer();

      const mkThinking = (id: string, createdAt: number, thinking: string): NormalizedMessage => ({
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'thinking', thinking, uuid: id, parentUUID: null }],
      });

      reducer(state, [mkThinking('t1', 1000, 'Hello')]);
      reducer(state, [mkThinking('t2', 1010, ' world')]);

      const thinkingMessages = [...state.messages.values()].filter(
        (m) => m.role === 'agent' && m.isThinking && typeof m.text === 'string',
      );
      expect(thinkingMessages).toHaveLength(1);
      expect(String(thinkingMessages[0]!.text)).toBe('Hello world');
    });

    it('preserves paragraph breaks streamed as standalone newline chunks', () => {
      const state = createReducer();

      const mkThinking = (id: string, createdAt: number, thinking: string): NormalizedMessage => ({
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'thinking', thinking, uuid: id, parentUUID: null }],
      });

      reducer(state, [mkThinking('t1', 1000, 'Hello')]);
      reducer(state, [mkThinking('t2', 1010, '\n\n')]);
      reducer(state, [mkThinking('t3', 1020, 'World')]);

      const thinkingMessages = [...state.messages.values()].filter(
        (m) => m.role === 'agent' && m.isThinking && typeof m.text === 'string',
      );
      expect(thinkingMessages).toHaveLength(1);

      expect(String(thinkingMessages[0]!.text)).toBe('Hello\n\nWorld');
    });

    it('does not wrap thinking text in a markdown "*Thinking...*" wrapper', () => {
      const state = createReducer();
      reducer(state, [{
        id: 't1',
        localId: null,
        createdAt: 1000,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'thinking', thinking: 'Hello', uuid: 't1', parentUUID: null }],
      }]);

      const thinkingMessages = [...state.messages.values()].filter(
        (m) => m.role === 'agent' && m.isThinking && typeof m.text === 'string',
      );
      expect(thinkingMessages).toHaveLength(1);
      expect(String(thinkingMessages[0]!.text)).toBe('Hello');
      expect(String(thinkingMessages[0]!.text)).not.toContain('*Thinking...*');
    });

    it('does not merge thinking across a tool-call boundary', () => {
      const state = createReducer();

      const mkThinking = (id: string, createdAt: number, thinking: string): NormalizedMessage => ({
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'thinking', thinking, uuid: id, parentUUID: null }],
      });

      const mkToolCall = (id: string, createdAt: number): NormalizedMessage => ({
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{
          type: 'tool-call',
          id: 'tool_1',
          name: 'bash',
          input: { cmd: 'echo hi' },
          description: null,
          uuid: id,
          parentUUID: null,
        }],
      });

      reducer(state, [mkThinking('t1', 1000, 'Hello')]);
      reducer(state, [mkToolCall('a2', 1010)]);
      reducer(state, [mkThinking('t3', 1020, 'World')]);

      const thinkingMessages = [...state.messages.values()].filter(
        (m) => m.role === 'agent' && m.isThinking && typeof m.text === 'string',
      );
      expect(thinkingMessages).toHaveLength(2);
      expect(String(thinkingMessages[0]!.text)).toBe('Hello');
      expect(String(thinkingMessages[1]!.text)).toBe('World');
    });
  });
});
