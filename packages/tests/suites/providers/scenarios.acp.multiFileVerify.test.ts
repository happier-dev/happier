import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeAcpMultiFileEditScenario } from '../../src/testkit/providers/scenarios.acp';

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
      };

      await expect(scenario.verify?.({ workspaceDir, fixtures } as any)).resolves.toBeUndefined();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
