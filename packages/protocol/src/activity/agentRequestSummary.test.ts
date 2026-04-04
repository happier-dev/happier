import { describe, expect, it } from 'vitest';

import {
  buildAgentRequestSemanticSummary,
  extractFirstUserActionQuestion,
  formatPermissionRequestSummary,
  summarizeToolInputForNotification,
} from './agentRequestSummary.js';

describe('buildAgentRequestSemanticSummary', () => {
  it('collects permission title and shell command semantics', () => {
    const summary = buildAgentRequestSemanticSummary({
      kind: 'permission',
      toolName: 'Bash',
      toolInput: {
        command: 'git status --short && echo secret-token',
        permission: { title: 'Use of this tool requires approval' },
      },
    });

    expect(summary).toMatchObject({
      normalizedToolLabel: 'Bash',
      permissionTitle: 'Use of this tool requires approval',
      shellCommand: 'git status --short && echo secret-token',
      firstQuestionText: null,
      questionCount: 0,
    });
  });

  it('collects AskUserQuestion prompt semantics', () => {
    const summary = buildAgentRequestSemanticSummary({
      kind: 'user_action',
      toolName: 'AskUserQuestion',
      toolInput: {
        questions: [{ question: 'Which branch should I use?' }],
      },
    });

    expect(summary).toMatchObject({
      firstQuestionText: 'Which branch should I use?',
      questionCount: 1,
    });
  });
});

describe('formatPermissionRequestSummary', () => {
  it('prefers permission title over inferred summaries', () => {
    expect(
      formatPermissionRequestSummary({
        toolName: 'bash',
        toolInput: {
          command: 'echo hello',
          permission: { title: 'Use of this tool requires approval' },
        },
      }),
    ).toBe('Use of this tool requires approval');
  });

  it('summarizes file permissions from nested ACP-style shapes', () => {
    expect(
      formatPermissionRequestSummary({
        toolName: 'read',
        toolInput: { toolCall: { content: [{ path: '/srv/data.txt' }] } },
      }),
    ).toBe('Read: /srv/data.txt');
  });
});

describe('extractFirstUserActionQuestion', () => {
  it('returns the first AskUserQuestion prompt text', () => {
    expect(
      extractFirstUserActionQuestion('AskUserQuestion', {
        questions: [
          { question: 'Which branch should I use?' },
          { question: 'Should I continue?' },
        ],
      }),
    ).toBe('Which branch should I use?');
  });

  it('accepts ask_user_question tool-name variants', () => {
    expect(
      extractFirstUserActionQuestion(' ask_user_question ', {
        questions: [
          { question: 'Which branch should I use?' },
        ],
      }),
    ).toBe('Which branch should I use?');
  });
});

describe('summarizeToolInputForNotification', () => {
  it('sanitizes shell tool details down to the command name', () => {
    expect(
      summarizeToolInputForNotification('Bash', { command: 'git status --short && echo secret-token' }),
    ).toBe('Command: git');
  });

  it('summarizes AskUserQuestion payloads by count for transport surfaces', () => {
    expect(
      summarizeToolInputForNotification('AskUserQuestion', {
        questions: [{ question: 'A?' }, { question: 'B?' }],
      }),
    ).toBe('2 questions');
  });

  it('summarizes ask_user_question payloads by count for transport surfaces', () => {
    expect(
      summarizeToolInputForNotification('ask_user_question', {
        questions: [{ question: 'A?' }, { question: 'B?' }],
      }),
    ).toBe('2 questions');
  });
});
