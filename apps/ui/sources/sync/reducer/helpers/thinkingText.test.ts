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

    it('reassembles tokenized bold markers in word-per-line streams (no extra spaces around "**")', () => {
      const input = ['**', 'Exploring', 'Reasoning', 'Options', '**', ''].join('\n');
      const normalized = normalizeThinkingChunk(input);
      expect(normalized).toBe('**Exploring Reasoning Options** ');
    });

    it('reassembles tokenized inline-code markers in word-per-line streams (no extra spaces around "`")', () => {
      const input = ['`', 'git', 'diff', '`', ''].join('\n');
      const normalized = normalizeThinkingChunk(input);
      expect(normalized).toBe('`git diff` ');
    });

    it('does not insert spaces before punctuation tokens in word-per-line streams', () => {
      const input = ['Hello', ',', 'world', '!', ''].join('\n');
      const normalized = normalizeThinkingChunk(input);
      expect(normalized).toBe('Hello, world! ');
    });

    it('preserves list newlines (does not collapse markdown lists into one line)', () => {
      const input = '- first item\n- second item\n';
      const normalized = normalizeThinkingChunk(input);
      expect(normalized).toContain('\n- second item');
    });

    it('collapses word-per-line deltas outside fenced code blocks (preserves fences verbatim)', () => {
      const input = ['Considering', 'commands', 'and', 'tools', '', '```sh', 'curl -I https://example.com', '```', ''].join(
        '\n',
      );
      const normalized = normalizeThinkingChunk(input);
      expect(normalized).toContain('Considering commands and tools');
      expect(normalized).toContain('```sh\ncurl -I https://example.com\n```');
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

    it('normalizes bare carriage returns into newlines (preserves intended line breaks)', () => {
      const input = 'Exploring reasoning options\rConsidering command and tools';
      const normalized = normalizeThinkingChunk(input);
      expect(normalized).toBe('Exploring reasoning options\nConsidering command and tools');
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

    it('inserts a space when streamed deltas omit boundary whitespace', () => {
      const state = createReducer();

      const mkThinking = (id: string, createdAt: number, thinking: string): NormalizedMessage => ({
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'thinking', thinking, uuid: id, parentUUID: null }],
      });

      reducer(state, [mkThinking('t1', 1000, 'Maybe I can streamline it a bit.')]);
      reducer(state, [mkThinking('t2', 1010, 'Outlining execution steps')]);

      const thinkingMessages = [...state.messages.values()].filter(
        (m) => m.role === 'agent' && m.isThinking && typeof m.text === 'string',
      );
      expect(thinkingMessages).toHaveLength(1);
      expect(String(thinkingMessages[0]!.text)).toBe('Maybe I can streamline it a bit. Outlining execution steps');
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

    it('does not split thinking when a whitespace-only agent text keepalive interleaves', () => {
      const state = createReducer();

      const mkThinking = (id: string, createdAt: number, thinking: string): NormalizedMessage => ({
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'thinking', thinking, uuid: id, parentUUID: null }],
      });

      const mkText = (id: string, createdAt: number, text: string): NormalizedMessage => ({
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'text', text, uuid: id, parentUUID: null }],
      });

      reducer(state, [mkThinking('t1', 1000, 'Respond')]);
      reducer(state, [mkText('a2', 1010, '\n')]);
      reducer(state, [mkThinking('t3', 1020, 'ing')]);

      const thinkingMessages = [...state.messages.values()].filter(
        (m) => m.role === 'agent' && m.isThinking && typeof m.text === 'string',
      );
      expect(thinkingMessages).toHaveLength(1);
      expect(String(thinkingMessages[0]!.text)).toBe('Responding');
    });

    it('dedupes overlapping streamed thinking chunks when providers resend cumulative text', () => {
      const state = createReducer();

      const mkThinking = (id: string, createdAt: number, thinking: string): NormalizedMessage => ({
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'thinking', thinking, uuid: id, parentUUID: null }],
      });

      reducer(state, [mkThinking('t1', 1000, 'Reading files with sed\n')]);
      reducer(state, [mkThinking('t2', 1010, 'Reading files with sed\nI will now execute commands.')]);

      const thinkingMessages = [...state.messages.values()].filter(
        (m) => m.role === 'agent' && m.isThinking && typeof m.text === 'string',
      );
      expect(thinkingMessages).toHaveLength(1);
      expect(String(thinkingMessages[0]!.text)).toBe('Reading files with sed\nI will now execute commands.');
    });

    it('dedupes drifted cumulative thinking chunks (minor quote/whitespace changes) by preferring replacement', () => {
      const state = createReducer();

      const mkThinking = (id: string, createdAt: number, thinking: string): NormalizedMessage => ({
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'thinking', thinking, uuid: id, parentUUID: null }],
      });

      reducer(state, [mkThinking('t1', 1000, 'Planning command execution\nI’ll start with exec_command.\n')]);
      reducer(state, [mkThinking('t2', 1010, 'Planning command execution\nI\'ll start with exec_command.\nDeciding on title update\n')]);

      const thinkingMessages = [...state.messages.values()].filter(
        (m) => m.role === 'agent' && m.isThinking && typeof m.text === 'string',
      );
      expect(thinkingMessages).toHaveLength(1);
      expect(String(thinkingMessages[0]!.text)).toBe(
        'Planning command execution\nI\'ll start with exec_command.\nDeciding on title update\n',
      );
    });

    it('inserts a space after sentence-ending punctuation even when followed by a closing quote', () => {
      const state = createReducer();

      const mkThinking = (id: string, createdAt: number, thinking: string): NormalizedMessage => ({
        id,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'thinking', thinking, uuid: id, parentUUID: null }],
      });

      reducer(state, [mkThinking('t1', 1000, 'I might go with \"Offline gap stream.\"')]);
      reducer(state, [mkThinking('t2', 1010, 'Deciding on title update')]);

      const thinkingMessages = [...state.messages.values()].filter(
        (m) => m.role === 'agent' && m.isThinking && typeof m.text === 'string',
      );
      expect(thinkingMessages).toHaveLength(1);
      expect(String(thinkingMessages[0]!.text)).toBe('I might go with \"Offline gap stream.\" Deciding on title update');
    });
  });
});
