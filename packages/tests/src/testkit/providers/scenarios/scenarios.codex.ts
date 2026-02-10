import type { ProviderScenario } from '../types';
import { hasStringSubstring } from '../assertions';
import {
  makeAcpPermissionOutsideWorkspaceScenario,
  makeAcpReadInWorkspaceScenario,
  makeAcpReadMissingFileScenario,
  makeAcpResumeFreshSessionImportsHistoryScenario,
  makeAcpResumeLoadSessionScenario,
  makeAcpGlobListFilesScenario,
  makeAcpMultiFileEditScenario,
  makeAcpPatchIncludesDiffScenario,
  makeAcpSearchKnownTokenScenario,
  makeAcpSearchLsEquivalenceScenario,
  makeAcpEditResultIncludesDiffScenario,
  makeAcpWriteInWorkspaceScenario,
} from './scenarios.acp';

export const codexScenarios: ProviderScenario[] = [
  {
    id: 'execute_trace_ok',
    title: 'execute: echo CODEX_TRACE_OK',
    tier: 'smoke',
    yolo: true,
    maxTraceEvents: { toolCalls: 1, toolResults: 1 },
    requiredFixtureKeys: [],
    prompt: () =>
      [
        'Run exactly one tool call:',
        '- Use the execute tool to run: echo CODEX_TRACE_OK',
        '- Then reply DONE.',
      ].join('\n'),
    requiredTraceSubstrings: ['CODEX_TRACE_OK'],
    verify: async ({ fixtures }) => {
      const examples = fixtures?.examples;
      if (!examples || typeof examples !== 'object') throw new Error('Invalid fixtures: missing examples');

      const keys = Object.keys(examples);
      const callKeys = keys.filter((k) => k.startsWith('acp/codex/tool-call/'));
      const resultKeys = keys.filter((k) => k.startsWith('acp/codex/tool-result/'));
      if (callKeys.length === 0) throw new Error('Expected at least one Codex tool-call fixture key');
      if (resultKeys.length === 0) throw new Error('Expected at least one Codex tool-result fixture key');

      const results = resultKeys.flatMap((k) => (Array.isArray((examples as any)[k]) ? (examples as any)[k] : []));
      const hasOk = results.some((e: any) => hasStringSubstring(e?.payload?.output, 'CODEX_TRACE_OK'));
      if (!hasOk) throw new Error('Codex tool-result did not include CODEX_TRACE_OK');
    },
  },
  makeAcpReadInWorkspaceScenario({
    providerId: 'codex',
    content: 'CODEX_READ_OK',
  }),
  makeAcpSearchKnownTokenScenario({
    providerId: 'codex',
    token: 'CODEX_SEARCH_OK',
  }),
  makeAcpWriteInWorkspaceScenario({
    providerId: 'codex',
    filename: 'e2e-write.txt',
    content: 'CODEX_WRITE_OK',
  }),
  makeAcpGlobListFilesScenario({
    providerId: 'codex',
    filenames: ['e2e-a.txt', 'e2e-b.txt'],
  }),
  makeAcpSearchLsEquivalenceScenario({
    providerId: 'codex',
    filenames: ['e2e-a.txt', 'e2e-b.txt'],
    token: 'CODEX_SEARCH_LS_EQUIV_OK',
  }),
  makeAcpReadMissingFileScenario({
    providerId: 'codex',
    filename: 'e2e-missing.txt',
  }),
  makeAcpPatchIncludesDiffScenario({
    providerId: 'codex',
    filename: 'e2e-patch.txt',
    before: 'CODEX_PATCH_BEFORE_OK',
    after: 'CODEX_PATCH_AFTER_OK',
  }),
  makeAcpEditResultIncludesDiffScenario({
    providerId: 'codex',
    filename: 'e2e-edit-diff.txt',
    before: 'CODEX_EDIT_DIFF_BEFORE_OK',
    after: 'CODEX_EDIT_DIFF_AFTER_OK',
  }),
  makeAcpMultiFileEditScenario({
    providerId: 'codex',
    files: [
      { filename: 'e2e-multi-a.txt', content: 'CODEX_MULTI_A_OK' },
      { filename: 'e2e-multi-b.txt', content: 'CODEX_MULTI_B_OK' },
    ],
  }),
  makeAcpPermissionOutsideWorkspaceScenario({
    providerId: 'codex',
    content: 'CODEX_OUTSIDE_OK',
    decision: 'approve',
  }),
  makeAcpPermissionOutsideWorkspaceScenario({
    providerId: 'codex',
    content: 'CODEX_OUTSIDE_DENIED_OK',
    decision: 'deny',
  }),
  makeAcpResumeLoadSessionScenario({
    providerId: 'codex',
    metadataKey: 'codexSessionId',
    phase1TraceSentinel: 'CODEX_RESUME_PHASE1_OK',
    phase2TraceSentinel: 'CODEX_RESUME_PHASE2_OK',
    title: 'resume: second attach uses --resume from session metadata (Codex ACP)',
  }),
  makeAcpResumeFreshSessionImportsHistoryScenario({
    providerId: 'codex',
    metadataKey: 'codexSessionId',
    phase1TraceSentinel: 'CODEX_IMPORT_PHASE1_TRACE_OK',
    phase1TextSentinel: 'CODEX_IMPORT_PHASE1_TEXT_OK',
    phase2TraceSentinel: 'CODEX_IMPORT_PHASE2_TRACE_OK',
    phase2TextSentinel: 'CODEX_IMPORT_PHASE2_TEXT_OK',
    title: 'resume: fresh session imports remote transcript history (Codex ACP)',
  }),
];

export const scenarios = codexScenarios;
