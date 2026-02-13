import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  makeAcpEditResultIncludesDiffScenario,
  makeAcpGlobListFilesScenario,
  makeAcpMultiFileEditIncludesDiffScenario,
  makeAcpMultiFileEditScenario,
  makeAcpPatchIncludesDiffScenario,
  makeAcpReadMissingFileScenario,
  makeAcpSearchLsEquivalenceScenario,
} from '../../src/testkit/providers/scenarios/scenarios.acp';
import type { ProviderFixtureExamples, ProviderTraceEvent } from '../../src/testkit/providers/types';

function buildVerifyContext(input: {
  workspaceDir: string;
  fixtures?: ProviderFixtureExamples;
  traceEvents?: ProviderTraceEvent[];
}) {
  return {
    workspaceDir: input.workspaceDir,
    fixtures: { examples: input.fixtures ?? {} },
    traceEvents: input.traceEvents ?? [],
    baseUrl: 'http://127.0.0.1:1',
    token: 'token',
    sessionId: 'session',
    resumeSessionId: null,
    secret: new Uint8Array(32),
    resumeId: null,
  };
}

function traceEvent(payload: unknown): ProviderTraceEvent {
  return {
    v: 1,
    sessionId: 'session',
    protocol: 'acp',
    provider: 'opencode',
    kind: 'tool-call',
    payload,
  };
}

describe('providers: ACP scenario builders (fs/search)', () => {
  it('builds a multi-file edit scenario that requires two file paths to be present in tool-call fixtures', () => {
    const files = [
      { filename: 'a.txt', content: 'A' },
      { filename: 'b.txt', content: 'B' },
    ];

    const scenario = makeAcpMultiFileEditScenario({
      providerId: 'opencode',
      files,
    });

    expect(scenario.id).toBe('multi_file_edit_in_workspace');
    expect(Array.isArray(scenario.requiredAnyFixtureKeys)).toBe(true);
    const steps = scenario.steps ?? [];
    expect(Array.isArray(scenario.steps)).toBe(true);
    expect(steps).toHaveLength(files.length);

    for (const file of files) {
      const step = steps.find((item) => typeof item?.id === 'string' && item.id.includes(file.filename));
      expect(step).toBeTruthy();
      const needles = step?.satisfaction?.requiredTraceSubstrings ?? [];
      expect(needles.some((needle) => needle.includes(file.filename))).toBe(true);
    }
  });

  it('multi-file edit verify accepts Patch tool inputs that use file_paths (not filepath)', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'happier-acp-multi-'));
    try {
      await writeFile(join(workspaceDir, 'a.txt'), 'A\n', 'utf8');
      await writeFile(join(workspaceDir, 'b.txt'), 'B\n', 'utf8');

      const scenario = makeAcpMultiFileEditScenario({
        providerId: 'opencode',
        files: [
          { filename: 'a.txt', content: 'A' },
          { filename: 'b.txt', content: 'B' },
        ],
      });

      const verify = scenario.verify;
      if (!verify) throw new Error('Scenario verify is required');
      await verify(
        buildVerifyContext({
          workspaceDir,
          fixtures: {
            'acp/opencode/tool-call/Patch': [
              { payload: { input: { file_paths: [join(workspaceDir, 'a.txt')] } } },
              { payload: { input: { file_paths: [join(workspaceDir, 'b.txt')] } } },
            ],
          },
        }),
      );
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('builds a glob list files scenario that accepts either Bash or CodeSearch-style tools', () => {
    const scenario = makeAcpGlobListFilesScenario({
      providerId: 'codex',
      filenames: ['e2e-a.txt', 'e2e-b.txt'],
    });

    const flat = (scenario.requiredAnyFixtureKeys ?? []).flat();
    expect(flat.some((key) => key.endsWith('/tool-call/Bash'))).toBe(true);
    expect(flat.some((key) => key.endsWith('/tool-call/CodeSearch'))).toBe(true);
    expect(flat.some((key) => key.endsWith('/tool-result/Bash'))).toBe(true);
    expect(flat.some((key) => key.endsWith('/tool-result/CodeSearch'))).toBe(true);
  });

  it('builds a search+ls equivalence scenario with two steps (ls then search)', () => {
    const scenario = makeAcpSearchLsEquivalenceScenario({
      providerId: 'opencode',
      filenames: ['e2e-a.txt', 'e2e-b.txt'],
      token: 'SEARCH_LS_TOKEN',
    });

    const steps = scenario.steps ?? [];
    expect(Array.isArray(scenario.steps)).toBe(true);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.id).toBe('ls');
    expect(steps[1]?.id).toBe('search');

    const flat = (scenario.requiredAnyFixtureKeys ?? []).flat();
    expect(flat.some((key) => key.includes('/tool-call/Bash'))).toBe(true);
    expect(flat.some((key) => key.includes('/tool-call/CodeSearch'))).toBe(true);
  });

  it('search+ls equivalence step 1 accepts either Bash or CodeSearch fixtures', () => {
    const scenario = makeAcpSearchLsEquivalenceScenario({
      providerId: 'codex',
      filenames: ['e2e-a.txt', 'e2e-b.txt'],
      token: 'SEARCH_LS_TOKEN',
    });

    const step = (scenario.steps ?? []).find((item) => item?.id === 'ls');
    expect(step).toBeTruthy();

    const flat = (step?.satisfaction?.requiredAnyFixtureKeys ?? []).flat();
    expect(flat.some((key) => key.includes('/tool-call/Bash') || key.includes('/tool-call/CodeSearch'))).toBe(true);
    expect(flat.some((key) => key.includes('/tool-result/Bash') || key.includes('/tool-result/CodeSearch'))).toBe(true);
    expect(flat.some((key) => key.includes('/tool-call/CodeSearch'))).toBe(true);
    expect(flat.some((key) => key.includes('/tool-result/CodeSearch'))).toBe(true);
  });

  it('search+ls equivalence requiredAnyFixtureKeys does not require Bash when CodeSearch is used for ls', () => {
    const scenario = makeAcpSearchLsEquivalenceScenario({
      providerId: 'codex',
      filenames: ['e2e-a.txt', 'e2e-b.txt'],
      token: 'SEARCH_LS_TOKEN',
    });

    const bucket = (scenario.requiredAnyFixtureKeys ?? []).find((keys) =>
      keys.some((key) => key.endsWith('/tool-call/Bash')),
    );
    expect(bucket).toBeTruthy();
    expect(bucket?.some((key) => key.endsWith('/tool-call/CodeSearch'))).toBe(true);
  });

  it('builds a patch-diff expectation scenario that requires Patch tool fixtures', () => {
    const scenario = makeAcpPatchIncludesDiffScenario({
      providerId: 'opencode',
      filename: 'e2e-patch.txt',
      before: 'BEFORE',
      after: 'AFTER',
    });

    const flat = (scenario.requiredAnyFixtureKeys ?? []).flat();
    expect(flat.some((key) => key.endsWith('/tool-call/Patch'))).toBe(true);
    expect(flat.some((key) => key.endsWith('/tool-result/Patch'))).toBe(true);
  });

  it('builds a file-edit diff expectation scenario that accepts either Edit or Patch fixtures', () => {
    const scenario = makeAcpEditResultIncludesDiffScenario({
      providerId: 'opencode',
      filename: 'e2e-edit.txt',
      before: 'BEFORE',
      after: 'AFTER',
    });

    const flat = (scenario.requiredAnyFixtureKeys ?? []).flat();
    expect(flat.some((key) => key.endsWith('/tool-call/Edit') || key.endsWith('/tool-call/Patch'))).toBe(true);
    expect(flat.some((key) => key.endsWith('/tool-result/Edit') || key.endsWith('/tool-result/Patch'))).toBe(true);
  });

  it('file-edit diff verify accepts Patch tool-call changes when Edit result diff is absent', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'happier-acp-editdiff-'));
    try {
      await writeFile(join(workspaceDir, 'e2e-edit.txt'), 'AFTER\n', 'utf8');

      const scenario = makeAcpEditResultIncludesDiffScenario({
        providerId: 'opencode',
        filename: 'e2e-edit.txt',
        before: 'BEFORE',
        after: 'AFTER',
      });

      const verify = scenario.verify;
      if (!verify) throw new Error('Scenario verify is required');
      await verify(
        buildVerifyContext({
          workspaceDir,
          traceEvents: [
            traceEvent({ type: 'tool-call', name: 'Patch', input: { changes: { one: { before: 'BEFORE', after: 'AFTER' } } } }),
          ],
        }),
      );
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('builds a multi-file edit scenario that asserts diff-like evidence in trace events', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'happier-acp-multi-diff-'));
    try {
      const scenario = makeAcpMultiFileEditIncludesDiffScenario({
        providerId: 'codex',
        files: [
          { filename: 'a.txt', before: 'A_BEFORE', after: 'A_AFTER' },
          { filename: 'b.txt', before: 'B_BEFORE', after: 'B_AFTER' },
        ],
      });

      expect(scenario.id).toBe('multi_file_edit_in_workspace_includes_diff');
      expect(Array.isArray(scenario.steps)).toBe(true);
      expect(scenario.steps).toHaveLength(2);
      const firstPrompt = scenario.steps?.[0]?.prompt({ workspaceDir }) ?? '';
      expect(firstPrompt).toContain('Patch tool');
      expect(firstPrompt).toContain('First, use the Read tool');
      expect(firstPrompt).toContain('Do not use execute');

      await scenario.setup?.({ workspaceDir });
      await writeFile(join(workspaceDir, 'a.txt'), 'A_AFTER\n', 'utf8');
      await writeFile(join(workspaceDir, 'b.txt'), 'B_AFTER\n', 'utf8');

      await scenario.verify?.(
        buildVerifyContext({
          workspaceDir,
          traceEvents: [
            traceEvent({
              type: 'tool-call',
              name: 'Patch',
              input: { changes: { 'a.txt': { before: 'A_BEFORE', after: 'A_AFTER' } } },
            }),
          ],
        }),
      );
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('builds a read-missing-file scenario that requires Read tool fixtures and does not create files', async () => {
    const scenario = makeAcpReadMissingFileScenario({
      providerId: 'opencode',
      filename: 'e2e-missing.txt',
    });

    expect(scenario.id).toBe('read_missing_file_in_workspace');
    const keys = scenario.requiredFixtureKeys ?? [];
    expect(keys.some((key) => key.endsWith('/tool-call/Read'))).toBe(true);
    expect(keys.some((key) => key.endsWith('/tool-result/Read'))).toBe(true);

    const workspaceDir = await mkdtemp(join(tmpdir(), 'happier-acp-missing-'));
    try {
      const verify = scenario.verify;
      if (!verify) throw new Error('Scenario verify is required');
      await verify(buildVerifyContext({ workspaceDir }));
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
