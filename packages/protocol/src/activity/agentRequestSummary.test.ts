import { describe, expect, it } from 'vitest';

import {
  resolveAgentRequestKind,
  buildAgentRequestSemanticSummary,
  classifyPermissionRequestRisk,
  extractFirstUserActionQuestion,
  formatPermissionRequestHeadline,
  formatPermissionRequestSummary,
  summarizeToolInputForNotification,
} from './agentRequestSummary.js';

describe('buildAgentRequestSemanticSummary', () => {
  it('projects a typed question without a provider tool alias', () => {
    const questionV1 = { mode: 'wait', lasting: false } as const;
    const toolName = 'custom_question_tool';
    const kind = resolveAgentRequestKind({ toolName, questionV1 });
    expect(buildAgentRequestSemanticSummary({ kind, toolName, questionV1,
      toolInput: { questions: [{ id: 'format', question: 'Which format?' }] },
    })).toMatchObject({ kind: 'user_action', questionCount: 1, firstQuestionText: 'Which format?' });
    expect(resolveAgentRequestKind({ toolName, requestKind: 'permission', questionV1 })).toBe('permission');
  });
  it.each([
    ['Bash', 'run_command'],
    ['exec_command', 'run_command'],
    ['exec', 'run_command'],
    ['Patch', 'change_files'],
    ['apply_patch', 'change_files'],
    ['Write', 'change_files'],
    ['Read', 'use_tool'],
    ['custom_tool', 'use_tool'],
  ])('retains the %s operation semantics without sharing its input', (toolName, permissionAction) => {
    expect(buildAgentRequestSemanticSummary({ kind: 'permission', toolName, toolInput: null }))
      .toMatchObject({ permissionAction, shellCommand: null, filePath: null });
  });

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
          header: 'Branch',
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
      header: 'Branch',
      question: 'Which branch should I use?',
      selection: 'single',
      required: true,
      allowCustom: false,
      choices: [
        { label: 'main', value: 'main', description: 'The default branch' },
        { label: 'release', value: 'release', description: null },
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
      header: null,
      question: 'Which release mode should I use?',
      selection: 'single',
      required: true,
      allowCustom: true,
      choices: [
        { label: 'Safe', value: 'safe', description: null },
        { label: 'Other', value: 'other', description: null },
      ],
    }, {
      answerKey: 'notes',
      header: null,
      question: 'Any notes?',
      selection: 'text',
      required: false,
      allowCustom: true,
      choices: [],
    }]);
  });
});

describe('formatPermissionRequestHeadline', () => {
  it('names what is asked with its verb, and stays null when only the generic line applies', () => {
    expect(formatPermissionRequestHeadline({ toolName: 'Edit', toolInput: { file_path: 'src/billing/webhooks.ts' } }))
      .toBe('Edit: src/billing/webhooks.ts');
    expect(formatPermissionRequestHeadline({ toolName: 'Bash', toolInput: { command: 'pnpm test' } })).toBe('Run: pnpm test');
    expect(formatPermissionRequestHeadline({ toolName: 'Bash', toolInput: { command: 'ls', permission: { title: 'List files' } } }))
      .toBe('List files');
    expect(formatPermissionRequestHeadline({ toolName: 'WebFetch', toolInput: { url: 'https://docs.stripe.com' } })).toBeNull();
    expect(formatPermissionRequestHeadline({ toolName: 'Edit', toolInput: {} })).toBeNull();
    expect(formatPermissionRequestSummary({ toolName: 'WebFetch', toolInput: { url: 'https://docs.stripe.com' } }))
      .toBe('Permission required: WebFetch');
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

  it('names the tool by the host label and phrases it in the host language, classifying by the raw tool', () => {
    const labels = {
      required: (tool: string) => `Permiso necesario: ${tool}`,
      run: (command: string) => `Ejecutar: ${command}`,
    };
    expect(formatPermissionRequestSummary({
      toolName: 'mcp__happier__action_spec_get',
      toolInput: { id: 'session.list' },
      toolLabel: 'Get action spec',
    })).toBe('Permission required: Get action spec');
    expect(formatPermissionRequestSummary({
      toolName: 'mcp__happier__action_spec_get',
      toolInput: { id: 'session.list' },
      toolLabel: 'Obtener especificación',
      labels,
    })).toBe('Permiso necesario: Obtener especificación');
    expect(formatPermissionRequestSummary({
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolLabel: 'Terminal',
      labels,
    })).toBe('Ejecutar: ls');
  });
});

describe('agent request tool label', () => {
  it('carries the host label for display while classification keeps the normalized tool name', () => {
    const labelled = buildAgentRequestSemanticSummary({
      kind: 'permission',
      toolName: 'mcp__happier__action_spec_get',
      toolInput: { id: 'session.list' },
      toolLabel: 'Get action spec',
    });
    expect(labelled).toMatchObject({ toolLabel: 'Get action spec', normalizedToolLabel: 'mcp__happier__action_spec_get' });
    expect(buildAgentRequestSemanticSummary({ kind: 'permission', toolName: 'Bash', toolInput: {} }).toolLabel).toBe('Bash');
    expect(buildAgentRequestSemanticSummary({ kind: 'permission', toolName: 'Bash', toolInput: {}, toolLabel: '  ' }).toolLabel).toBe('Bash');
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
  it('uses the caller locale for a full-form question summary', () => {
    expect(summarizeToolInputForNotification('AskUserQuestion', {
      questions: Array.from({ length: 5 }, (_, index) => ({ question: `Question ${index}?` })),
    }, { answerAll: count => `Répondre aux ${count} questions dans Happier` }))
      .toBe('Répondre aux 5 questions dans Happier');
  });

  it.each([
    { questionCount: 5, choiceCount: 2 },
    { questionCount: 1, choiceCount: 9 },
  ])('opens the full form above the remote question or choice cap: %o', ({ questionCount, choiceCount }) => {
    const toolInput = {
      questions: Array.from({ length: questionCount }, (_, index) => ({
        id: `question-${index}`,
        question: `Private question ${index}?`,
        options: Array.from({ length: choiceCount }, (_, choice) => ({ label: `Choice ${choice}` })),
      })),
    };
    expect(summarizeToolInputForNotification('AskUserQuestion', toolInput))
      .toBe(`Answer all ${questionCount} in Happier`);
    expect(buildAgentRequestSemanticSummary({ kind: 'user_action', toolName: 'AskUserQuestion', toolInput }).questions)
      .toHaveLength(questionCount);
  });

  it('keeps all questions and choices visible at the existing remote caps', () => {
    const details = summarizeToolInputForNotification('AskUserQuestion', {
      questions: Array.from({ length: 4 }, (_, index) => ({
        question: `Question ${index}?`,
        options: Array.from({ length: 8 }, (_, choice) => ({ label: `Choice ${choice}` })),
      })),
    });
    expect(details).toContain('Question 3?');
    expect(details).toContain('Choice 7');
    expect(details).not.toContain('Answer all');
  });

  it.each([
    ['ExitPlanMode', { name: 'Migration', overview: 'Preserve existing data', plan: '1. Back up\n2. Apply migration' }, ['Migration', 'Preserve existing data', '1. Back up', '2. Apply migration']],
    ['AcpHistoryImport', { note: 'History differs. Importing may duplicate messages.', reason: 'no_overlap' }, ['History differs. Importing may duplicate messages.']],
    ['WebFetch', { url: 'https://example.test/documentation' }, ['https://example.test/documentation']],
    ['WebSearch', { query: 'How to migrate SQLite data' }, ['How to migrate SQLite data']],
  ])('includes the supplied context for %s', (toolName, toolInput, expected) => {
    const details = summarizeToolInputForNotification(toolName, toolInput);
    for (const text of expected) expect(details).toContain(text);
  });

  it('retains all arguments in script arrays', () => {
    expect(summarizeToolInputForNotification('Execute', { script: ['git', 'diff', '--stat'] })).toBe('Command: git diff --stat');
  });

  it('retains complete file names and rationale from permission requests', () => {
    const details = summarizeToolInputForNotification('Edit', {
      filename: 'C:\\Users\\alice\\work\\project\\src\\main.ts',
      rationale: 'Apply the reviewed change',
    });
    expect(details).toContain('C:\\Users\\alice\\work\\project\\src\\main.ts');
    expect(details).toContain('Apply the reviewed change');
  });

  it('retains full shell details', () => {
    expect(
      summarizeToolInputForNotification('Bash', { command: 'git status --short && echo secret-token' }),
    ).toBe('Command: git status --short && echo secret-token');
  });

  it('summarizes AskUserQuestion payloads with complete text for transport surfaces', () => {
    expect(
      summarizeToolInputForNotification('AskUserQuestion', {
        questions: [{ question: 'A?' }, { question: 'B?' }],
      }),
    ).toContain('A?\nCustom answer allowed\n\nB?');
  });

  it('summarizes ask_user_question payloads with complete text for transport surfaces', () => {
    expect(
      summarizeToolInputForNotification('ask_user_question', {
        questions: [{ question: 'A?' }, { question: 'B?' }],
      }),
    ).toContain('A?\nCustom answer allowed\n\nB?');
  });
});


describe('resolveAgentRequestKind', () => {
  it.each(['AskUserQuestion', 'ask_user_question', 'ExitPlanMode', 'exit_plan_mode', 'AcpHistoryImport'])(
    'preserves legacy user-action classification for %s', (toolName) => {
      expect(resolveAgentRequestKind({ toolName })).toBe('user_action');
      expect(resolveAgentRequestKind({ toolName, requestKind: 'permission' })).toBe('permission');
    },
  );
  it('uses explicit action kind and defaults unrecognized tools to permission', () => {
    expect(resolveAgentRequestKind({ toolName: 'Bash', requestKind: 'user_action' })).toBe('user_action');
    expect(resolveAgentRequestKind({ toolName: 'Bash', requestKind: 'unknown' })).toBe('permission');
  });
});
