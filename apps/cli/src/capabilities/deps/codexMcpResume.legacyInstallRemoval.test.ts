import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_HOME = process.env.HAPPIER_HOME_DIR;
const tempDirs = new Set<string>();

afterEach(async () => {
  if (ORIGINAL_HOME === undefined) delete process.env.HAPPIER_HOME_DIR;
  else process.env.HAPPIER_HOME_DIR = ORIGINAL_HOME;
  vi.resetModules();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe.sequential('codexMcpResume dep status', () => {
  it('does not treat the legacy codex-resume install dir as installed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-codex-mcp-resume-'));
    tempDirs.add(home);
    process.env.HAPPIER_HOME_DIR = home;

    const binName = process.platform === 'win32' ? 'codex-mcp-resume.cmd' : 'codex-mcp-resume';
    const legacyBin = join(home, 'tools', 'codex-resume', 'node_modules', '.bin', binName);
    await mkdir(join(home, 'tools', 'codex-resume', 'node_modules', '.bin'), { recursive: true });
    await writeFile(legacyBin, '#!/bin/sh\necho ok\n', 'utf8');
    if (process.platform !== 'win32') {
      await chmod(legacyBin, 0o755);
    }

    const { getCodexMcpResumeDepStatus } = await import('./codexMcpResume');
    const status = await getCodexMcpResumeDepStatus({ onlyIfInstalled: true });
    expect(status.installed).toBe(false);
  });
});

