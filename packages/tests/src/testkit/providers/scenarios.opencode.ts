import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderScenario } from './types';
import { shapeOf, stableStringifyShape } from './shape';
import { hasStringSubstring, waitForAcpSidechainMessages } from './assertions';
import {
  makeAcpPermissionOutsideWorkspaceScenario,
  makeAcpPermissionDenyOutsideWorkspaceReadScenario,
  makeAcpMultiFileEditScenario,
  makeAcpEditResultIncludesDiffScenario,
  makeAcpReadMissingFileScenario,
  makeAcpResumeFreshSessionImportsHistoryScenario,
  makeAcpResumeLoadSessionScenario,
  makeAcpSearchLsEquivalenceScenario,
  makeAcpSearchKnownTokenScenario,
  makeAcpGlobListFilesScenario,
  makeAcpWriteInWorkspaceScenario,
} from './scenarios.acp';

export const scenarios: ProviderScenario[] = [
  {
    id: 'execute_trace_ok',
    title: 'execute: echo TRACE_OK',
    tier: 'smoke',
    yolo: true,
    maxTraceEvents: { toolCalls: 1, toolResults: 1 },
    prompt: () =>
      [
        'Run exactly one tool call:',
        '- Use the execute tool to run: echo TRACE_OK',
        '- Then reply DONE.',
      ].join('\n'),
    // OpenCode currently surfaces execute calls as the canonical tool `Bash`, with `_happier.rawToolName="execute"`.
    requiredFixtureKeys: ['acp/opencode/tool-call/Bash', 'acp/opencode/tool-result/Bash'],
    requiredTraceSubstrings: ['TRACE_OK'],
    verify: async ({ fixtures }) => {
      const examples = fixtures?.examples;
      if (!examples || typeof examples !== 'object') throw new Error('Invalid fixtures: missing examples');

      const calls = (examples['acp/opencode/tool-call/Bash'] ?? []) as any[];
      if (!Array.isArray(calls) || calls.length === 0) throw new Error('Missing execute tool-call fixtures');
      const hasHappierExecute = calls.some(
        (e) => e?.payload?.name === 'Bash' && e?.payload?.input?._happier?.rawToolName === 'execute',
      );
      if (!hasHappierExecute) throw new Error('Expected OpenCode execute normalization (_happier.rawToolName="execute") on Bash tool-call');

      const results = (examples['acp/opencode/tool-result/Bash'] ?? []) as any[];
      if (!Array.isArray(results) || results.length === 0) throw new Error('Missing execute tool-result fixtures');
      const hasOk = results.some((e) => hasStringSubstring(e?.payload?.output, 'TRACE_OK'));
      if (!hasOk) throw new Error('execute tool-result did not include TRACE_OK in output');
      const hasExit0 = results.some((e) => e?.payload?.output?.metadata?.exit === 0);
      if (!hasExit0) throw new Error('execute tool-result did not include metadata.exit=0');

      // Shape pin: ensures key structure doesn’t drift silently.
      const callShape = stableStringifyShape(shapeOf(calls[0]?.payload));
      const resultShape = stableStringifyShape(shapeOf(results[0]?.payload));
      if (!callShape.includes('"_happier"') || !callShape.includes('"rawToolName"') || !resultShape.includes('"_happier"')) {
        throw new Error('Unexpected execute tool-call/tool-result payload shape');
      }
    },
  },
  {
    ...makeAcpResumeLoadSessionScenario({
      providerId: 'opencode',
      metadataKey: 'opencodeSessionId',
      phase1TraceSentinel: 'RESUME_PHASE1_OK',
      phase2TraceSentinel: 'RESUME_PHASE2_OK',
    }),
    id: 'acp_resume_load_session',
    title: 'resume: second attach uses --resume from session metadata',
    tier: 'extended',
    yolo: true,
    // Two phases, each should run a single execute call.
    maxTraceEvents: { toolCalls: 2, toolResults: 2 },
  },
  {
    ...makeAcpResumeFreshSessionImportsHistoryScenario({
      providerId: 'opencode',
      metadataKey: 'opencodeSessionId',
      phase1TraceSentinel: 'IMPORT_PHASE1_TRACE_OK',
      phase1TextSentinel: 'IMPORT_PHASE1_TEXT_OK',
      phase2TraceSentinel: 'IMPORT_PHASE2_TRACE_OK',
      phase2TextSentinel: 'IMPORT_PHASE2_TEXT_OK',
    }),
    id: 'acp_resume_fresh_session_imports_history',
    title: 'resume: fresh session imports remote transcript history',
    tier: 'extended',
    yolo: true,
    maxTraceEvents: { toolCalls: 2, toolResults: 2 },
  },
  {
    id: 'execute_error_exit_2',
    title: 'execute: echo TRACE_ERR && exit 2',
    tier: 'smoke',
    yolo: true,
    maxTraceEvents: { toolCalls: 1, toolResults: 1 },
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
    id: 'task_subagent_reply',
    title: 'task: returns a child session id in tool-result metadata',
    tier: 'extended',
    yolo: true,
    // Some ACP providers emit a few "refresh" tool-call updates for the same callId; allow a small buffer.
    // Also allow a small number of extra tool results in case the provider emits summary/metadata updates.
    maxTraceEvents: { toolCalls: 25, toolResults: 4 },
    postSatisfy: { waitForAcpSidechainFromToolName: 'Task', timeoutMs: 60_000 },
    prompt: ({ workspaceDir }) =>
      [
        'Run exactly one tool call:',
        '- Use the task tool (not execute) with this exact prompt:',
        '  Respond with EXACTLY: SUBTASK_OK',
        '- The subtask must not call any tools.',
        '- Do not use any other tools.',
        '- Then reply DONE.',
        '',
        `Note: current working directory is ${workspaceDir}`,
      ].join('\n'),
    requiredFixtureKeys: ['acp/opencode/tool-call/Task', 'acp/opencode/tool-result/Task'],
    // OpenCode task results include a <task_metadata> section with a child session id.
    requiredTraceSubstrings: ['session_id:', 'SUBTASK_OK'],
    verify: async ({ fixtures, baseUrl, token, sessionId, secret }) => {
      const results = (fixtures?.examples?.['acp/opencode/tool-result/Task'] ?? []) as any[];
      if (!Array.isArray(results) || results.length === 0) throw new Error('Missing task tool-result fixtures');
      const hasChildSessionId = results.some((e) => typeof e?.payload?.output?.metadata?.sessionId === 'string' && e.payload.output.metadata.sessionId.length > 0);
      if (!hasChildSessionId) throw new Error('task tool-result did not include metadata.sessionId (child session id)');

      const calls = (fixtures?.examples?.['acp/opencode/tool-call/Task'] ?? []) as any[];
      const sidechainId =
        (Array.isArray(calls) && calls.length > 0 && typeof calls[0]?.payload?.callId === 'string' ? calls[0].payload.callId : null) ??
        (typeof results[0]?.payload?.callId === 'string' ? results[0].payload.callId : null);
      if (!sidechainId) throw new Error('Missing Task callId (needed to assert sidechain import)');

      // Sidechain import happens asynchronously after the Task tool-result surfaces the child session id.
      const sidechain = await waitForAcpSidechainMessages({
        baseUrl,
        token,
        sessionId,
        secret,
        sidechainId,
        timeoutMs: 60_000,
      });
      if (sidechain.messages.length === 0) {
        throw new Error('Expected at least one imported sidechain message, but none were found');
      }
      const hasImportedMeta = sidechain.messages.some((m) => m?.meta?.importedFrom === 'acp-sidechain');
      if (!hasImportedMeta) {
        throw new Error('Sidechain messages found, but none were tagged with meta.importedFrom="acp-sidechain"');
      }
    },
  },
  {
    id: 'read_known_file',
    title: 'read: read a known file in workspace',
    tier: 'extended',
    yolo: true,
    maxTraceEvents: { toolCalls: 1, toolResults: 1 },
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
    ...makeAcpSearchKnownTokenScenario({ providerId: 'opencode', token: 'SEARCH_TOKEN_XYZ' }),
    verify: async ({ fixtures }) => {
      const examples = fixtures?.examples;
      if (!examples || typeof examples !== 'object') throw new Error('Invalid fixtures: missing examples');
      const results =
        ((examples['acp/opencode/tool-result/CodeSearch'] ?? []) as any[])
          .concat((examples['acp/opencode/tool-result/Search'] ?? []) as any[])
          .concat((examples['acp/opencode/tool-result/Grep'] ?? []) as any[]);
      if (results.length === 0) throw new Error('Missing search tool-result fixtures');
      const hasHappierSearch = results.some((e) => e?.payload?.output?._happier?.rawToolName === 'search');
      if (!hasHappierSearch) throw new Error('Expected OpenCode search normalization (_happier.rawToolName="search") on tool-result');
    },
  },
  makeAcpGlobListFilesScenario({
    providerId: 'opencode',
    filenames: ['e2e-a.txt', 'e2e-b.txt'],
  }),
  makeAcpSearchLsEquivalenceScenario({
    providerId: 'opencode',
    filenames: ['e2e-a.txt', 'e2e-b.txt'],
    token: 'SEARCH_LS_EQUIV_E2E',
  }),
  makeAcpReadMissingFileScenario({
    providerId: 'opencode',
    filename: 'e2e-missing.txt',
  }),
  makeAcpEditResultIncludesDiffScenario({
    providerId: 'opencode',
    filename: 'e2e-edit-diff.txt',
    before: 'BEFORE_EDIT_DIFF_E2E',
    after: 'AFTER_EDIT_DIFF_E2E',
  }),
  makeAcpWriteInWorkspaceScenario({
    providerId: 'opencode',
    id: 'edit_write_file_and_cat',
    title: 'edit: write file and cat it',
    filename: 'e2e-write.txt',
    content: 'HELLO_E2E',
  }),
  makeAcpMultiFileEditScenario({
    providerId: 'opencode',
    files: [
      { filename: 'e2e-multi-a.txt', content: 'MULTI_A_E2E' },
      { filename: 'e2e-multi-b.txt', content: 'MULTI_B_E2E' },
    ],
  }),
  makeAcpPermissionOutsideWorkspaceScenario({ providerId: 'opencode', content: 'OUTSIDE_E2E', decision: 'approve' }),
  makeAcpPermissionOutsideWorkspaceScenario({ providerId: 'opencode', content: 'OUTSIDE_DENIED_E2E', decision: 'deny' }),
  makeAcpPermissionDenyOutsideWorkspaceReadScenario({ providerId: 'opencode', token: 'OUTSIDE_READ_DENIED_E2E' }),
];
