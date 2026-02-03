import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import type { ProviderScenario } from './types';

function hasStringSubstring(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.some((v) => hasStringSubstring(v, needle));
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some((v) => hasStringSubstring(v, needle));
  return false;
}

export const claudeScenarios: ProviderScenario[] = [
  {
    id: 'bash_echo_trace_ok',
    title: 'Bash: echo CLAUDE_TRACE_OK',
    tier: 'smoke',
    yolo: true,
    prompt: () =>
      [
        'Run exactly one tool call:',
        '- Use the Bash tool to run: echo CLAUDE_TRACE_OK',
        '- Then reply DONE.',
        '',
        'Do not use any other tool.',
      ].join('\n'),
    requiredFixtureKeys: ['claude/claude/tool-call/Bash', 'claude/claude/tool-result/Bash'],
    requiredTraceSubstrings: ['CLAUDE_TRACE_OK'],
    verify: async ({ fixtures }) => {
      const examples = fixtures?.examples;
      if (!examples || typeof examples !== 'object') throw new Error('Invalid fixtures: missing examples');

      const calls = (examples['claude/claude/tool-call/Bash'] ?? []) as any[];
      if (!Array.isArray(calls) || calls.length === 0) throw new Error('Missing Bash tool-call fixtures');
      const hasEcho = calls.some((e) => hasStringSubstring(e?.payload?.input, 'echo CLAUDE_TRACE_OK'));
      if (!hasEcho) throw new Error('Bash tool-call did not include expected command substring');
    },
  },
  {
    id: 'read_known_file',
    title: 'Read: read a known file in workspace',
    tier: 'extended',
    yolo: true,
    setup: async ({ workspaceDir }) => {
      await writeFile(join(workspaceDir, 'e2e-read.txt'), 'READ_SENTINEL_CLAUDE_123\n', 'utf8');
    },
    prompt: ({ workspaceDir }) =>
      [
        'Use the Read tool (not Bash) to read the file at this absolute path:',
        join(workspaceDir, 'e2e-read.txt'),
        'Then reply DONE.',
      ].join('\n'),
    requiredFixtureKeys: ['claude/claude/tool-call/Read', 'claude/claude/tool-result/Read'],
    verify: async ({ fixtures, workspaceDir }) => {
      const examples = fixtures?.examples;
      if (!examples || typeof examples !== 'object') throw new Error('Invalid fixtures: missing examples');
      const calls = (examples['claude/claude/tool-call/Read'] ?? []) as any[];
      if (!Array.isArray(calls) || calls.length === 0) throw new Error('Missing Read tool-call fixtures');
      const expectedPath = join(workspaceDir, 'e2e-read.txt');
      const hasPath = calls.some((e) => hasStringSubstring(e?.payload?.input, expectedPath));
      if (!hasPath) throw new Error('Read tool-call did not include expected file path');
    },
  },
  {
    id: 'permission_surface_outside_workspace',
    title: 'permissions: writing outside workspace surfaces a permission-request trace (approve)',
    tier: 'extended',
    yolo: false,
    permissionAutoDecision: 'approved',
    requiredFixtureKeys: [],
    prompt: ({ workspaceDir }) => {
      const outsidePath = join(tmpdir(), `happy-e2e-claude-outside-${randomUUID()}.txt`);
      return [
        'Run exactly one tool call (even if it triggers a permission prompt):',
        'Use the Write tool to write a file OUTSIDE the current working directory:',
        `- Absolute path: ${outsidePath}`,
        '- Content: OUTSIDE_CLAUDE_E2E',
        '',
        'This is an automated test. Do not use Bash to write the file.',
        'Then reply DONE.',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n');
    },
    requiredAnyFixtureKeys: [
      ['claude/claude/permission-request/Write', 'claude/claude/permission-request/Edit'],
      ['claude/claude/tool-call/Write', 'claude/claude/tool-call/Edit'],
    ],
    verify: async ({ fixtures }) => {
      const reqs =
        ((fixtures?.examples?.['claude/claude/permission-request/Write'] ?? []) as any[])
          .concat((fixtures?.examples?.['claude/claude/permission-request/Edit'] ?? []) as any[]);
      if (!Array.isArray(reqs) || reqs.length === 0) throw new Error('Missing permission-request/Write fixtures');
      const filepath = reqs[0]?.payload?.input?.file_path;
      if (typeof filepath !== 'string' || filepath.length === 0) throw new Error('permission-request/Write missing input.file_path');
      const content = await readFile(filepath, 'utf8').catch(() => '');
      if (!content.includes('OUTSIDE_CLAUDE_E2E')) {
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
    requiredFixtureKeys: [],
    prompt: ({ workspaceDir }) => {
      const outsidePath = join(tmpdir(), `happy-e2e-claude-outside-denied-${randomUUID()}.txt`);
      return [
        'Run exactly one tool call (even if it triggers a permission prompt):',
        'Use the Write tool to write a file OUTSIDE the current working directory:',
        `- Absolute path: ${outsidePath}`,
        '- Content: OUTSIDE_CLAUDE_DENIED_E2E',
        '',
        'This is an automated test. Do not use Bash to write the file.',
        'If the permission is denied, do not retry with other tools.',
        'Then reply DONE.',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n');
    },
    requiredAnyFixtureKeys: [
      ['claude/claude/permission-request/Write', 'claude/claude/permission-request/Edit'],
      ['claude/claude/tool-call/Write', 'claude/claude/tool-call/Edit'],
    ],
    verify: async ({ fixtures }) => {
      const reqs =
        ((fixtures?.examples?.['claude/claude/permission-request/Write'] ?? []) as any[])
          .concat((fixtures?.examples?.['claude/claude/permission-request/Edit'] ?? []) as any[]);
      if (!Array.isArray(reqs) || reqs.length === 0) throw new Error('Missing permission-request/Write fixtures');
      const filepath = reqs[0]?.payload?.input?.file_path;
      if (typeof filepath !== 'string' || filepath.length === 0) throw new Error('permission-request/Write missing input.file_path');
      if (existsSync(filepath)) {
        throw new Error(`Denied permission but file exists on disk: ${filepath}`);
      }
    },
  },
];
