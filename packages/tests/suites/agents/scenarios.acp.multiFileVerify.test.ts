import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeAcpMultiFileEditScenario } from '../../src/testkit/providers/scenarios/scenarios.acp';
import type { ProviderFixtures, ProviderScenario, ProviderTraceEvent } from '../../src/testkit/providers/types';

type VerifyContext = Parameters<NonNullable<ProviderScenario['verify']>>[0];

function buildVerifyContext(input: {
  workspaceDir: string;
  fixtures: ProviderFixtures;
  traceEvents?: ProviderTraceEvent[];
}): VerifyContext {
  return {
    workspaceDir: input.workspaceDir,
    fixtures: input.fixtures,
    traceEvents: input.traceEvents ?? [],
    baseUrl: 'http://127.0.0.1:1',
    token: 'token',
    sessionId: 'session',
    resumeSessionId: null,
    secret: new Uint8Array(32),
    resumeId: null,
  };
}

describe('providers: ACP multi-file verify', () => {
  it('accepts second file path evidence from tool-result metadata filepath', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'happy-e2e-multi-file-'));
    try {
      await writeFile(join(workspaceDir, 'e2e-multi-a.txt'), 'MULTI_A_E2E\n', 'utf8');
      await writeFile(join(workspaceDir, 'e2e-multi-b.txt'), 'MULTI_B_E2E\n', 'utf8');

      const scenario = makeAcpMultiFileEditScenario({
        providerId: 'kilo',
        files: [
          { filename: 'e2e-multi-a.txt', content: 'MULTI_A_E2E' },
          { filename: 'e2e-multi-b.txt', content: 'MULTI_B_E2E' },
        ],
      });

      const fixtures = {
        examples: {
          'acp/kilo/tool-call/Write': [
            {
              payload: {
                input: {
                  filePath: `${workspaceDir}/e2e-multi-a.txt`,
                },
              },
            },
          ],
          'acp/kilo/tool-result/Write': [
            {
              payload: {
                output: {
                  metadata: {
                    filepath: `${workspaceDir}/e2e-multi-b.txt`,
                  },
                },
              },
            },
          ],
        },
      } satisfies ProviderFixtures;

      const verify = scenario.verify;
      if (!verify) throw new Error('Scenario verify is required');
      await expect(verify(buildVerifyContext({ workspaceDir, fixtures }))).resolves.toBeUndefined();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('rejects outside-workspace writes for an in-workspace multi-file scenario (even if fixtures point outside)', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'happy-e2e-multi-file-'));
    const outsideDir = await mkdtemp(join(tmpdir(), 'happy-e2e-multi-file-outside-'));
    try {
      const outsideA = join(outsideDir, 'e2e-multi-a.txt');
      const outsideB = join(outsideDir, 'e2e-multi-b.txt');
      await writeFile(outsideA, 'MULTI_A_E2E\n', 'utf8');
      await writeFile(outsideB, 'MULTI_B_E2E\n', 'utf8');

      const scenario = makeAcpMultiFileEditScenario({
        providerId: 'auggie',
        files: [
          { filename: 'e2e-multi-a.txt', content: 'MULTI_A_E2E' },
          { filename: 'e2e-multi-b.txt', content: 'MULTI_B_E2E' },
        ],
        useAbsolutePath: true,
      });

      const fixtures = {
        examples: {
          'acp/auggie/tool-call/Edit': [
            { payload: { input: { locations: [{ path: outsideA }] } } },
            { payload: { input: { locations: [{ path: outsideB }] } } },
          ],
          'acp/auggie/tool-result/Edit': [
            { payload: { output: { metadata: { filepath: outsideA } } } },
            { payload: { output: { metadata: { filepath: outsideB } } } },
          ],
        },
      } satisfies ProviderFixtures;

      const verify = scenario.verify;
      if (!verify) throw new Error('Scenario verify is required');
      await expect(verify(buildVerifyContext({ workspaceDir, fixtures }))).rejects.toThrow(/Expected file content not present/i);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('does not require per-file fixture path evidence when file contents are verified', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'happy-e2e-multi-file-'));
    try {
      await writeFile(join(workspaceDir, 'e2e-multi-a.txt'), 'MULTI_A_E2E\n', 'utf8');
      await writeFile(join(workspaceDir, 'e2e-multi-b.txt'), 'MULTI_B_E2E\n', 'utf8');

      const scenario = makeAcpMultiFileEditScenario({
        providerId: 'opencode',
        files: [
          { filename: 'e2e-multi-a.txt', content: 'MULTI_A_E2E' },
          { filename: 'e2e-multi-b.txt', content: 'MULTI_B_E2E' },
        ],
      });

      const verify = scenario.verify;
      if (!verify) throw new Error('Scenario verify is required');
      await expect(verify(buildVerifyContext({ workspaceDir, fixtures: { examples: {} } }))).resolves.toBeUndefined();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
