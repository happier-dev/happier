import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ProviderScenario } from './types';
import { hasStringSubstring } from './assertions';
import { fetchSessionV2 } from '../sessions';
import { decryptLegacyBase64 } from '../messageCrypto';
import { sleep } from '../timing';
import { cleanupOutsideWorkspacePath, makeOutsideWorkspacePath } from './outsideWorkspacePath';

const agentSdkRemoteMetaBase = {
  claudeRemoteAgentSdkEnabled: true,
  claudeRemoteSettingSources: 'project',
} as const;

function withAgentSdkRemoteMeta(base: ProviderScenario, params: { id: string; title: string; metaExtras?: Record<string, unknown> }): ProviderScenario {
  const mergeMeta = (meta: Record<string, unknown>) => ({
    ...meta,
    ...agentSdkRemoteMetaBase,
    ...(params.metaExtras ?? {}),
  });

  const messageMeta = base.messageMeta;
  const existingMeta =
    messageMeta && typeof messageMeta === 'object' && !Array.isArray(messageMeta)
      ? (messageMeta as Record<string, unknown>)
      : null;
  return {
    ...base,
    id: params.id,
    title: params.title,
    messageMeta:
      typeof messageMeta === 'function'
        ? (ctx) => {
            const resolved = messageMeta(ctx);
            const record =
              resolved && typeof resolved === 'object' && !Array.isArray(resolved) ? (resolved as Record<string, unknown>) : {};
            return mergeMeta(record);
          }
        : mergeMeta(existingMeta ?? {}),
  };
}

const readKnownFileScenario: ProviderScenario = {
  id: 'read_known_file',
  title: 'Read: read a known file in workspace',
  tier: 'extended',
  yolo: true,
  maxTraceEvents: { toolCalls: 1, toolResults: 1, permissionRequests: 1 },
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
};

let permissionSurfaceOutsideWorkspacePath: string | null = null;

const permissionSurfaceOutsideWorkspaceScenario: ProviderScenario = {
  id: 'permission_surface_outside_workspace',
  title: 'permissions: writing outside workspace surfaces a permission-request trace (approve)',
  tier: 'extended',
  yolo: false,
  permissionAutoDecision: 'approved',
  requiredFixtureKeys: [],
  setup: async ({ workspaceDir }) => {
    permissionSurfaceOutsideWorkspacePath = makeOutsideWorkspacePath({
      workspaceDir,
      prefix: 'happy-e2e-claude-outside-approve',
    });
    await cleanupOutsideWorkspacePath(permissionSurfaceOutsideWorkspacePath);
  },
  prompt: ({ workspaceDir }) => {
    const outsidePath = permissionSurfaceOutsideWorkspacePath;
    if (typeof outsidePath !== 'string' || outsidePath.length === 0) {
      throw new Error('Internal error: outsidePath not initialized');
    }
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
    try {
      const content = await readFile(filepath, 'utf8').catch(() => '');
      if (!content.includes('OUTSIDE_CLAUDE_E2E')) {
        throw new Error(`Approved permission but expected content was not written: ${filepath}`);
      }
    } finally {
      await cleanupOutsideWorkspacePath(filepath);
      permissionSurfaceOutsideWorkspacePath = null;
    }
  },
};

let permissionDenyOutsideWorkspacePath: string | null = null;

const permissionDenyOutsideWorkspaceScenario: ProviderScenario = {
  id: 'permission_deny_outside_workspace',
  title: 'permissions: deny an outside-workspace write and verify it did not happen',
  tier: 'extended',
  yolo: false,
  permissionAutoDecision: 'denied',
  requiredFixtureKeys: [],
  setup: async ({ workspaceDir }) => {
    permissionDenyOutsideWorkspacePath = makeOutsideWorkspacePath({
      workspaceDir,
      prefix: 'happy-e2e-claude-outside-denied',
    });
    await cleanupOutsideWorkspacePath(permissionDenyOutsideWorkspacePath);
  },
  prompt: ({ workspaceDir }) => {
    const outsidePath = permissionDenyOutsideWorkspacePath;
    if (typeof outsidePath !== 'string' || outsidePath.length === 0) {
      throw new Error('Internal error: outsidePath not initialized');
    }
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
    try {
      if (existsSync(filepath)) {
        throw new Error(`Denied permission but file exists on disk: ${filepath}`);
      }
    } finally {
      await cleanupOutsideWorkspacePath(filepath);
      permissionDenyOutsideWorkspacePath = null;
    }
  },
};

export const claudeScenarios: ProviderScenario[] = [
  {
    id: 'bash_echo_trace_ok',
    title: 'Bash: echo CLAUDE_TRACE_OK',
    tier: 'smoke',
    yolo: true,
    maxTraceEvents: { toolCalls: 1, toolResults: 1, permissionRequests: 1 },
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
  readKnownFileScenario,
  withAgentSdkRemoteMeta(readKnownFileScenario, { id: 'agent_sdk_read_known_file', title: 'agent sdk: Read: read a known file in workspace' }),
  permissionSurfaceOutsideWorkspaceScenario,
  withAgentSdkRemoteMeta(permissionSurfaceOutsideWorkspaceScenario, {
    id: 'agent_sdk_permission_surface_outside_workspace',
    title: 'agent sdk: permissions: writing outside workspace surfaces a permission-request trace (approve)',
  }),
  permissionDenyOutsideWorkspaceScenario,
  withAgentSdkRemoteMeta(permissionDenyOutsideWorkspaceScenario, {
    id: 'agent_sdk_permission_deny_outside_workspace',
    title: 'agent sdk: permissions: deny an outside-workspace write and verify it did not happen',
  }),
  {
    id: 'agent_sdk_transcript_path_published',
    title: 'agent sdk: SessionStart hook publishes transcript path in session metadata',
    tier: 'extended',
    yolo: true,
    messageMeta: agentSdkRemoteMetaBase,
    maxTraceEvents: { toolCalls: 1, toolResults: 1, permissionRequests: 1 },
    prompt: () =>
      [
        'Run exactly one tool call:',
        '- Use the Bash tool to run: echo AGENTSDK_TRANSCRIPT_OK',
        '- Then reply DONE.',
        '',
        'Do not use any other tool.',
      ].join('\n'),
    requiredFixtureKeys: ['claude/claude/tool-call/Bash', 'claude/claude/tool-result/Bash'],
    requiredTraceSubstrings: ['AGENTSDK_TRANSCRIPT_OK'],
    verify: async ({ baseUrl, token, sessionId, secret }) => {
      const snap = await fetchSessionV2(baseUrl, token, sessionId);
      const metadata = decryptLegacyBase64(snap.metadata, secret) as any;
      const claudeSessionId = typeof metadata?.claudeSessionId === 'string' ? metadata.claudeSessionId : '';
      const transcriptPath = typeof metadata?.claudeTranscriptPath === 'string' ? metadata.claudeTranscriptPath : '';
      if (!claudeSessionId) throw new Error('Missing metadata.claudeSessionId (expected Agent SDK hook to publish it)');
      if (!transcriptPath) throw new Error('Missing metadata.claudeTranscriptPath (expected Agent SDK hook to publish it)');
      const startedAt = Date.now();
      while (Date.now() - startedAt < 15_000 && !existsSync(transcriptPath)) {
        await sleep(250);
      }
      if (!existsSync(transcriptPath)) throw new Error(`metadata.claudeTranscriptPath does not exist: ${transcriptPath}`);
    },
  },
  {
    id: 'agent_sdk_partial_messages_smoke',
    title: 'agent sdk: includePartialMessages does not break tool-trace session flow',
    tier: 'extended',
    yolo: true,
    messageMeta: { ...agentSdkRemoteMetaBase, claudeRemoteIncludePartialMessages: true },
    maxTraceEvents: { toolCalls: 1, toolResults: 1, permissionRequests: 1 },
    prompt: () =>
      [
        'Run exactly one tool call:',
        '- Use the Bash tool to run: echo AGENTSDK_PARTIAL_OK',
        '- Then reply DONE.',
        '',
        'Do not use any other tool.',
      ].join('\n'),
    requiredFixtureKeys: ['claude/claude/tool-call/Bash', 'claude/claude/tool-result/Bash'],
    requiredTraceSubstrings: ['AGENTSDK_PARTIAL_OK'],
  },
  {
    id: 'agent_sdk_checkpoint_and_rewind_restores_fs',
    title: 'agent sdk: file checkpointing + /rewind restores workspace filesystem',
    tier: 'extended',
    yolo: true,
    messageMeta: {
      ...agentSdkRemoteMetaBase,
      claudeRemoteEnableFileCheckpointing: true,
    },
    steps: [
      {
        id: 'write',
        prompt: ({ workspaceDir }) =>
          [
            'Use the Write tool (not Bash) to create a new file in the current working directory:',
            `- Absolute path: ${join(workspaceDir, 'rewind-sentinel.txt')}`,
            '- Content: REWIND_SENTINEL_CLAUDE_E2E',
            'Then reply DONE.',
          ].join('\n'),
        satisfaction: {
          requiredAnyFixtureKeys: [
            ['claude/claude/tool-call/Write', 'claude/claude/tool-call/Edit'],
            ['claude/claude/tool-result/Write', 'claude/claude/tool-result/Edit'],
          ],
        },
      },
        {
          id: 'rewind',
          prompt: () => '/rewind --confirm',
          satisfaction: {
            requiredTraceSubstrings: ['checkpoint-rewind'],
          },
        },
    ],
    requiredFixtureKeys: [],
    requiredAnyFixtureKeys: [
      ['claude/claude/tool-call/Write', 'claude/claude/tool-call/Edit'],
      ['claude/claude/tool-result/Write', 'claude/claude/tool-result/Edit'],
    ],
    requiredTraceSubstrings: ['checkpoint-rewind'],
    verify: async ({ baseUrl, token, sessionId, secret, workspaceDir }) => {
      const snap = await fetchSessionV2(baseUrl, token, sessionId);
      const metadata = decryptLegacyBase64(snap.metadata, secret) as any;
      const checkpointId = typeof metadata?.claudeLastCheckpointId === 'string' ? metadata.claudeLastCheckpointId : '';
      if (!checkpointId) throw new Error('Missing metadata.claudeLastCheckpointId after checkpointing run');

      const sentinelPath = join(workspaceDir, 'rewind-sentinel.txt');
      if (existsSync(sentinelPath)) {
        throw new Error(`Expected /rewind to remove ${sentinelPath}, but it still exists`);
      }
    },
  },
];

export const scenarios = claudeScenarios;
