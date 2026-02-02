import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ProviderScenario } from './types';
import { shapeOf, stableStringifyShape } from './shape';

function hasStringSubstring(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.some((v) => hasStringSubstring(v, needle));
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some((v) => hasStringSubstring(v, needle));
  return false;
}

export const opencodeScenarios: ProviderScenario[] = [
  {
    id: 'execute_trace_ok',
    title: 'execute: echo TRACE_OK',
    tier: 'smoke',
    yolo: true,
    prompt: () =>
      [
        'Run exactly one tool call:',
        '- Use the execute tool to run: echo TRACE_OK',
        '- Then reply DONE.',
      ].join('\n'),
    requiredFixtureKeys: ['acp/opencode/tool-call/execute', 'acp/opencode/tool-result/execute'],
    requiredTraceSubstrings: ['TRACE_OK'],
    verify: async ({ fixtures }) => {
      const examples = fixtures?.examples;
      if (!examples || typeof examples !== 'object') throw new Error('Invalid fixtures: missing examples');

      const calls = (examples['acp/opencode/tool-call/execute'] ?? []) as any[];
      if (!Array.isArray(calls) || calls.length === 0) throw new Error('Missing execute tool-call fixtures');
      const hasCommand = calls.some((e) => hasStringSubstring(e?.payload?.input?.command, 'echo TRACE_OK'));
      if (!hasCommand) {
        // Some traces may route the command through `_acp.rawInput.cmd` depending on OpenCode version.
        const hasAlt = calls.some((e) => hasStringSubstring(e?.payload?.input?._acp?.rawInput?.cmd, 'echo TRACE_OK'));
        if (!hasAlt) throw new Error('execute tool-call did not include expected command shape');
      }

      const results = (examples['acp/opencode/tool-result/execute'] ?? []) as any[];
      if (!Array.isArray(results) || results.length === 0) throw new Error('Missing execute tool-result fixtures');
      const hasOk = results.some((e) => hasStringSubstring(e?.payload?.output, 'TRACE_OK'));
      if (!hasOk) throw new Error('execute tool-result did not include TRACE_OK in output');

      // Shape pin: ensures key structure doesn’t drift silently.
      const callShape = stableStringifyShape(shapeOf(calls[0]?.payload));
      const resultShape = stableStringifyShape(shapeOf(results[0]?.payload));
      if (!callShape.includes('"name"') || !callShape.includes('"input"') || !resultShape.includes('"output"')) {
        throw new Error('Unexpected execute tool-call/tool-result payload shape');
      }
    },
  },
  {
    id: 'execute_error_exit_2',
    title: 'execute: echo TRACE_ERR && exit 2',
    tier: 'smoke',
    yolo: true,
    prompt: () =>
      [
        'Use the execute tool to run this exact command:',
        'sh -lc "echo TRACE_ERR && exit 2"',
        'Then reply DONE.',
      ].join('\n'),
    requiredFixtureKeys: ['acp/opencode/tool-call/execute', 'acp/opencode/tool-result/execute'],
    requiredTraceSubstrings: ['TRACE_ERR'],
    verify: async ({ fixtures }) => {
      const results = (fixtures?.examples?.['acp/opencode/tool-result/execute'] ?? []) as any[];
      if (!Array.isArray(results) || results.length === 0) throw new Error('Missing execute tool-result fixtures');
      const hasErr = results.some((e) => hasStringSubstring(e?.payload?.output, 'TRACE_ERR'));
      if (!hasErr) throw new Error('execute tool-result did not include TRACE_ERR');
    },
  },
  {
    id: 'read_known_file',
    title: 'read: read a known file in workspace',
    tier: 'extended',
    yolo: true,
    setup: async ({ workspaceDir }) => {
      await writeFile(join(workspaceDir, 'e2e-read.txt'), 'READ_SENTINEL_123\n', 'utf8');
    },
    prompt: ({ workspaceDir }) =>
      [
        'Use the read tool (not execute) to read the file:',
        '- Path: e2e-read.txt',
        'Then reply DONE.',
        '',
        'The output must include: READ_SENTINEL_123',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    requiredFixtureKeys: ['acp/opencode/tool-call/read', 'acp/opencode/tool-result/read'],
    requiredTraceSubstrings: ['READ_SENTINEL_123'],
  },
  {
    id: 'search_known_token',
    title: 'search: find a known token in workspace',
    tier: 'extended',
    yolo: true,
    setup: async ({ workspaceDir }) => {
      await writeFile(join(workspaceDir, 'e2e-search.txt'), 'alpha\nbeta\nSEARCH_TOKEN_XYZ\n', 'utf8');
    },
    prompt: ({ workspaceDir }) =>
      [
        'Use the search tool (not execute) to search for the exact token:',
        'SEARCH_TOKEN_XYZ',
        'Search within the current working directory.',
        'Then reply DONE.',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    requiredAnyFixtureKeys: [
      ['acp/opencode/tool-call/search', 'acp/opencode/tool-call/grep'],
      ['acp/opencode/tool-result/search', 'acp/opencode/tool-result/grep'],
    ],
    requiredFixtureKeys: [],
    requiredTraceSubstrings: ['SEARCH_TOKEN_XYZ'],
  },
  {
    id: 'glob_list_files',
    title: 'glob/ls: list files in workspace',
    tier: 'extended',
    yolo: true,
    setup: async ({ workspaceDir }) => {
      await writeFile(join(workspaceDir, 'e2e-a.txt'), 'A\n', 'utf8');
      await writeFile(join(workspaceDir, 'e2e-b.txt'), 'B\n', 'utf8');
    },
    prompt: ({ workspaceDir }) =>
      [
        'List files in the current working directory using a file listing tool.',
        'Prefer the glob tool with pattern: e2e-*.txt',
        'If glob is not available, use ls instead.',
        'Then reply DONE.',
        '',
        'The output must include both: e2e-a.txt and e2e-b.txt',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    requiredAnyFixtureKeys: [
      ['acp/opencode/tool-call/glob', 'acp/opencode/tool-call/ls'],
      ['acp/opencode/tool-result/glob', 'acp/opencode/tool-result/ls'],
    ],
    requiredFixtureKeys: [],
    requiredTraceSubstrings: ['e2e-a.txt', 'e2e-b.txt'],
  },
  {
    id: 'edit_write_file_and_cat',
    title: 'edit: write file and cat it',
    tier: 'extended',
    yolo: true,
    prompt: ({ workspaceDir }) =>
      [
        'Create a new file inside the current working directory:',
        '- Path: e2e-write.txt',
        '- Content: HELLO_E2E',
        '',
        'Do NOT use execute to write the file; use the edit tool.',
        'Then use execute to run: cat e2e-write.txt',
        'Ensure the output includes HELLO_E2E.',
        'Then reply DONE.',
        '',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    requiredFixtureKeys: [
      'acp/opencode/tool-call/execute',
      'acp/opencode/tool-result/execute',
    ],
    requiredAnyFixtureKeys: [
      ['acp/opencode/tool-call/edit', 'acp/opencode/tool-call/write'],
      ['acp/opencode/tool-result/edit', 'acp/opencode/tool-result/write'],
    ],
    requiredTraceSubstrings: ['HELLO_E2E'],
    verify: async ({ workspaceDir }) => {
      const filePath = join(workspaceDir, 'e2e-write.txt');
      const content = await readFile(filePath, 'utf8');
      if (!content.includes('HELLO_E2E')) {
        throw new Error('Expected file content not present after provider run');
      }
    },
  },
  {
    id: 'permission_surface_outside_workspace',
    title: 'permissions: editing outside workspace surfaces a permission-request trace',
    tier: 'extended',
    yolo: false,
    prompt: ({ workspaceDir }) => {
      const outsidePath = join(tmpdir(), `happy-e2e-outside-${randomUUID()}.txt`);
      return [
        'Attempt to write a file OUTSIDE the current working directory using the edit tool:',
        `- Absolute path: ${outsidePath}`,
        '- Content: OUTSIDE_E2E',
        '',
        'This is an automated test. Do not use execute to write the file.',
        'Then reply DONE.',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n');
    },
    requiredFixtureKeys: ['acp/opencode/permission-request/edit'],
    requiredAnyFixtureKeys: [
      ['acp/opencode/tool-call/edit', 'acp/opencode/tool-call/write'],
    ],
    requiredTraceSubstrings: ['OUTSIDE_E2E'],
  },
];
