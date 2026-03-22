import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

import { executionRunsCapability } from './toolExecutionRuns';
import type { DetectCliEntry, DetectCliSnapshot } from '../snapshots/cliSnapshot';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

function makeUnavailableCliEntry(): DetectCliEntry {
  return { available: false };
}

function makeCliSnapshot(overrides: Partial<DetectCliSnapshot['clis']>, path = ''): DetectCliSnapshot {
  return {
    path,
    clis: {
      claude: makeUnavailableCliEntry(),
      codex: makeUnavailableCliEntry(),
      gemini: makeUnavailableCliEntry(),
      opencode: makeUnavailableCliEntry(),
      auggie: makeUnavailableCliEntry(),
      qwen: makeUnavailableCliEntry(),
      kimi: makeUnavailableCliEntry(),
      kilo: makeUnavailableCliEntry(),
      kiro: makeUnavailableCliEntry(),
      customAcp: makeUnavailableCliEntry(),
      pi: makeUnavailableCliEntry(),
      copilot: makeUnavailableCliEntry(),
      ...overrides,
    },
    tmux: { available: false },
    windowsTerminal: { available: false },
  };
}

describe('executionRunsCapability', () => {
  const envScope = createEnvKeyScope(['PATH', 'HAPPIER_CODERABBIT_REVIEW_CMD', 'HAPPIER_CODEX_BACKEND_MODE']);

  beforeEach(() => {
    envScope.restore();
    envScope.patch({
      HAPPIER_CODERABBIT_REVIEW_CMD: 'coderabbit',
      HAPPIER_CODEX_BACKEND_MODE: undefined,
    });
  });

  afterEach(() => {
    envScope.restore();
  });

  it('reports supportsVendorResume per backend for UI gating', async () => {
    const res = await executionRunsCapability.detect({
      context: {
        cliSnapshot: makeCliSnapshot({ claude: { available: true }, codex: { available: true } }),
      },
      request: { id: 'tool.executionRuns' },
    }) as {
      available: boolean;
      backends: Record<string, { supportsVendorResume?: boolean; available?: boolean }>;
    };

    expect(res?.available).toBe(true);
    expect(res?.backends?.claude).toBeTruthy();
    expect(typeof res.backends.claude.supportsVendorResume).toBe('boolean');
    expect(res.backends.codex).toMatchObject({
      available: true,
      supportsVendorResume: true,
    });
    expect(res.backends.kiro).toBeTruthy();
    expect(typeof res.backends.kiro.supportsVendorResume).toBe('boolean');
    expect(res.backends.customAcp).toMatchObject({
      available: true,
      supportsVendorResume: false,
    });
    expect(res.backends.pi).toBeTruthy();
    expect(typeof res.backends.pi.supportsVendorResume).toBe('boolean');
    expect(res.backends.copilot).toBeTruthy();
  });

  it('detects native coderabbit availability from process PATH even when cliSnapshot.path is empty', async () => {
    // Ensure we test PATH detection (not the override).
    await withTempDir('happier-coderabbit-path-test-', async (dir) => {
      envScope.patch({ HAPPIER_CODERABBIT_REVIEW_CMD: undefined });

      const bin = join(dir, 'coderabbit');
      await writeFile(
        bin,
        '#!/usr/bin/env bash\n' +
          'echo \"coderabbit\"',
        'utf8',
      );
      await chmod(bin, 0o755);

      const pathLookup = process.env.PATH ?? '';
      envScope.patch({ PATH: `${dir}${pathLookup ? `:${pathLookup}` : ''}` });

      const res = await executionRunsCapability.detect({
        context: {
          cliSnapshot: makeCliSnapshot({ claude: { available: true } }),
        },
        request: { id: 'tool.executionRuns' },
      }) as {
        available: boolean;
        backends: { coderabbit?: { available?: boolean } };
      };

      expect(res?.available).toBe(true);
      expect(res?.backends?.coderabbit?.available).toBe(true);
    });
  });

  it('reports Codex resume support from the effective runtime mode (HAPPIER_CODEX_BACKEND_MODE)', async () => {
    process.env.HAPPIER_CODEX_BACKEND_MODE = 'mcp';

    const res = await executionRunsCapability.detect({
      context: {
        cliSnapshot: makeCliSnapshot({ codex: { available: true } }),
      },
      request: { id: 'tool.executionRuns' },
    }) as {
      available: boolean;
      backends: Record<string, { supportsVendorResume?: boolean; available?: boolean }>;
    };

    expect(res?.available).toBe(true);
    expect(res.backends.codex).toMatchObject({
      available: true,
      supportsVendorResume: false,
    });
  });
});
