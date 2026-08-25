import { describe, expect, it } from 'vitest';

import {
  buildAgentRequestSemanticSummary,
  classifyPermissionRequestRisk,
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

  it('keeps the real AskUserQuestion choices at the semantic-summary owner', () => {
    const summary = buildAgentRequestSemanticSummary({
      kind: 'user_action',
      toolName: 'AskUserQuestion',
      toolInput: {
        questions: [{
          question: 'Which branch should I use?',
          options: [
            { label: 'main', description: 'The default branch' },
            { label: 'release' },
          ],
        }],
      },
    });

    expect(summary.questions).toEqual([{
      answerKey: 'Which branch should I use?',
      question: 'Which branch should I use?',
      selection: 'single',
      required: true,
      allowCustom: false,
      choices: [
        { label: 'main', value: 'main' },
        { label: 'release', value: 'release' },
      ],
    }]);
  });

  it('retains the live question answer semantics needed by a remote mediator', () => {
    const summary = buildAgentRequestSemanticSummary({
      kind: 'user_action',
      toolName: 'AskUserQuestion',
      toolInput: {
        questions: [{
          id: 'release-mode',
          question: 'Which release mode should I use?',
          selection: 'single',
          required: true,
          allowCustom: true,
          options: [
            { id: 'safe', label: 'Safe' },
            { id: 'other', label: 'Other' },
          ],
        }, {
          id: 'notes',
          question: 'Any notes?',
          selection: 'text',
          required: false,
        }],
      },
    });

    expect(summary.questions).toEqual([{
      answerKey: 'release-mode',
      question: 'Which release mode should I use?',
      selection: 'single',
      required: true,
      allowCustom: true,
      choices: [
        { label: 'Safe', value: 'safe' },
        { label: 'Other', value: 'other' },
      ],
    }, {
      answerKey: 'notes',
      question: 'Any notes?',
      selection: 'text',
      required: false,
      allowCustom: true,
      choices: [],
    }]);
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

describe('classifyPermissionRequestRisk', () => {
  it('classifies mutating file tools as high risk', () => {
    for (const toolName of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Delete']) {
      expect(classifyPermissionRequestRisk({ toolName, toolInput: { path: 'src/app.ts' } })).toBe('high');
    }
  });

  it('classifies read-only tools as low risk', () => {
    for (const toolName of ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'BashOutput']) {
      expect(classifyPermissionRequestRisk({ toolName, toolInput: { path: 'src/app.ts' } })).toBe('low');
    }
  });

  it('classifies obvious shell inspection commands as low risk', () => {
    for (const command of ['git status --short', 'pwd', 'ls -la', 'rg "TODO" src', 'cat package.json']) {
      expect(classifyPermissionRequestRisk({ toolName: 'Bash', toolInput: { command } })).toBe('low');
    }
  });

  it('classifies mutating or unknown shell commands as high risk', () => {
    for (const command of [
      'npm install',
      'rm -rf dist',
      'git push origin main',
      'python scripts/deploy.py',
      'git status --short && echo done',
    ]) {
      expect(classifyPermissionRequestRisk({ toolName: 'Bash', toolInput: { command } })).toBe('high');
    }
    expect(classifyPermissionRequestRisk({ toolName: 'Bash', toolInput: {} })).toBe('high');
  });

  it('classifies unknown tools as high risk', () => {
    expect(classifyPermissionRequestRisk({ toolName: 'RunDangerousThing', toolInput: {} })).toBe('high');
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
