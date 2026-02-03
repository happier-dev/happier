import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
    // OpenCode currently surfaces execute calls as the canonical tool `Bash`, with `_happy.rawToolName="execute"`.
    requiredFixtureKeys: ['acp/opencode/tool-call/Bash', 'acp/opencode/tool-result/Bash'],
    requiredTraceSubstrings: ['TRACE_OK'],
    verify: async ({ fixtures }) => {
      const examples = fixtures?.examples;
      if (!examples || typeof examples !== 'object') throw new Error('Invalid fixtures: missing examples');

      const calls = (examples['acp/opencode/tool-call/Bash'] ?? []) as any[];
      if (!Array.isArray(calls) || calls.length === 0) throw new Error('Missing execute tool-call fixtures');
      const hasHappyExecute = calls.some(
        (e) => e?.payload?.name === 'Bash' && e?.payload?.input?._happy?.rawToolName === 'execute',
      );
      if (!hasHappyExecute) throw new Error('Expected OpenCode execute normalization (_happy.rawToolName="execute") on Bash tool-call');

      const results = (examples['acp/opencode/tool-result/Bash'] ?? []) as any[];
      if (!Array.isArray(results) || results.length === 0) throw new Error('Missing execute tool-result fixtures');
      const hasOk = results.some((e) => hasStringSubstring(e?.payload?.output, 'TRACE_OK'));
      if (!hasOk) throw new Error('execute tool-result did not include TRACE_OK in output');
      const hasExit0 = results.some((e) => e?.payload?.output?.metadata?.exit === 0);
      if (!hasExit0) throw new Error('execute tool-result did not include metadata.exit=0');

      // Shape pin: ensures key structure doesn’t drift silently.
      const callShape = stableStringifyShape(shapeOf(calls[0]?.payload));
      const resultShape = stableStringifyShape(shapeOf(results[0]?.payload));
      if (!callShape.includes('"_happy"') || !callShape.includes('"rawToolName"') || !resultShape.includes('"_happy"')) {
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
    requiredFixtureKeys: ['acp/opencode/tool-call/Bash', 'acp/opencode/tool-result/Bash'],
    requiredTraceSubstrings: ['TRACE_ERR'],
    verify: async ({ fixtures }) => {
      const results = (fixtures?.examples?.['acp/opencode/tool-result/Bash'] ?? []) as any[];
      if (!Array.isArray(results) || results.length === 0) throw new Error('Missing execute tool-result fixtures');
      const hasErr = results.some((e) => hasStringSubstring(e?.payload?.output, 'TRACE_ERR'));
      if (!hasErr) throw new Error('execute tool-result did not include TRACE_ERR');
      const hasExit2 = results.some((e) => e?.payload?.output?.metadata?.exit === 2);
      if (!hasExit2) throw new Error('execute tool-result did not include metadata.exit=2');
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
    requiredFixtureKeys: ['acp/opencode/tool-call/Read', 'acp/opencode/tool-result/Read'],
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
      ['acp/opencode/tool-call/CodeSearch', 'acp/opencode/tool-call/Search', 'acp/opencode/tool-call/Grep'],
      ['acp/opencode/tool-result/CodeSearch', 'acp/opencode/tool-result/Search', 'acp/opencode/tool-result/Grep'],
    ],
    requiredFixtureKeys: [],
    requiredTraceSubstrings: ['SEARCH_TOKEN_XYZ'],
    verify: async ({ fixtures }) => {
      const examples = fixtures?.examples;
      if (!examples || typeof examples !== 'object') throw new Error('Invalid fixtures: missing examples');
      const results =
        ((examples['acp/opencode/tool-result/CodeSearch'] ?? []) as any[])
          .concat((examples['acp/opencode/tool-result/Search'] ?? []) as any[])
          .concat((examples['acp/opencode/tool-result/Grep'] ?? []) as any[]);
      if (results.length === 0) throw new Error('Missing search tool-result fixtures');
      const hasHappySearch = results.some((e) => e?.payload?.output?._happy?.rawToolName === 'search');
      if (!hasHappySearch) throw new Error('Expected OpenCode search normalization (_happy.rawToolName="search") on tool-result');
    },
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
        'Run exactly one tool call:',
        '- Use the execute tool to run: ls -1 e2e-*.txt',
        '- Do not use any other tool (especially do not use search).',
        'Then reply DONE.',
        '',
        'The output must include both: e2e-a.txt and e2e-b.txt',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    requiredFixtureKeys: ['acp/opencode/tool-call/Bash', 'acp/opencode/tool-result/Bash'],
    requiredTraceSubstrings: ['e2e-a.txt', 'e2e-b.txt'],
  },
  {
    id: 'edit_write_file_and_cat',
    title: 'edit: write file and cat it',
    tier: 'extended',
    yolo: true,
    requiredFixtureKeys: [],
    prompt: ({ workspaceDir }) =>
      [
        'Create a new file inside the current working directory:',
        '- Path: e2e-write.txt',
        '- Content: HELLO_E2E',
        '',
        'Do NOT use execute to write the file; use the edit tool.',
        'Optionally, verify by using execute to run: cat e2e-write.txt',
        'Then reply DONE.',
        '',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    requiredAnyFixtureKeys: [
      ['acp/opencode/tool-call/Edit', 'acp/opencode/tool-call/Write'],
      ['acp/opencode/tool-result/Edit', 'acp/opencode/tool-result/Write'],
    ],
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
        'Run exactly one tool call (even if it triggers a permission prompt):',
        'Use the edit tool to write a file OUTSIDE the current working directory:',
        `- Absolute path: ${outsidePath}`,
        '- Content: OUTSIDE_E2E',
        '',
        'This is an automated test. Do not use execute to write the file.',
        'Then reply DONE.',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n');
    },
    requiredFixtureKeys: ['acp/opencode/permission-request/Edit'],
    requiredAnyFixtureKeys: [
      ['acp/opencode/tool-call/Edit', 'acp/opencode/tool-call/Write'],
    ],
    verify: async ({ fixtures }) => {
      const reqs = (fixtures?.examples?.['acp/opencode/permission-request/Edit'] ?? []) as any[];
      if (!Array.isArray(reqs) || reqs.length === 0) throw new Error('Missing permission-request/Edit fixtures');
      const filepath = reqs[0]?.payload?.options?.input?.filepath;
      if (typeof filepath !== 'string' || filepath.length === 0) throw new Error('permission-request/Edit missing options.input.filepath');
      const content = await readFile(filepath, 'utf8').catch(() => '');
      if (!content.includes('OUTSIDE_E2E')) {
        throw new Error(`Approved permission but expected content was not written: ${filepath}`);
      }
    },
  },
  {
    id: 'permission_deny_outside_workspace',
    title: 'permissions: deny an outside-workspace write and verify it did not happen',
    tier: 'extended',
    yolo: false,
    permissionAutoDecision: 'denied',
    prompt: ({ workspaceDir }) => {
      const outsidePath = join(tmpdir(), `happy-e2e-outside-denied-${randomUUID()}.txt`);
      return [
        'Run exactly one tool call (even if it triggers a permission prompt):',
        'Use the edit tool to write a file OUTSIDE the current working directory:',
        `- Absolute path: ${outsidePath}`,
        '- Content: OUTSIDE_DENIED_E2E',
        '',
        'This is an automated test. Do not use execute to write the file.',
        'If the permission is denied, do not retry with other tools.',
        'Then reply DONE.',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n');
    },
    requiredFixtureKeys: ['acp/opencode/permission-request/Edit'],
    requiredAnyFixtureKeys: [
      ['acp/opencode/tool-call/Edit', 'acp/opencode/tool-call/Write'],
    ],
    verify: async ({ fixtures }) => {
      const reqs = (fixtures?.examples?.['acp/opencode/permission-request/Edit'] ?? []) as any[];
      if (!Array.isArray(reqs) || reqs.length === 0) throw new Error('Missing permission-request/Edit fixtures');
      const filepath = reqs[0]?.payload?.options?.input?.filepath;
      if (typeof filepath !== 'string' || filepath.length === 0) throw new Error('permission-request/Edit missing options.input.filepath');
      if (existsSync(filepath)) {
        throw new Error(`Denied permission but file exists on disk: ${filepath}`);
      }
    },
  },
];
