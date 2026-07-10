import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createOhMyPiBackendEngine } from './engine.js';

const tempDirs = new Set<string>();

function rememberTempDir(path: string): string {
  tempDirs.add(path);
  return path;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('createOhMyPiBackendEngine terminal runtime surface', () => {
  it('resolves the terminal transcript binding from plugin-owned breadcrumbs', async () => {
    const agentDir = rememberTempDir(await mkdtemp(join(tmpdir(), 'happier-ohmypi-terminal-engine-')));
    const cwd = join(agentDir, 'workspace');
    const sessionRoot = join(agentDir, 'sessions', '-workspace');
    const sessionFile = join(sessionRoot, '2026-04-10T10-00-00-000Z_session-one.jsonl');
    await mkdir(join(agentDir, 'terminal-sessions'), { recursive: true });
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(sessionFile, '{"type":"session","id":"session-one"}\n', 'utf8');
    await writeFile(join(agentDir, 'terminal-sessions', 'pts-3'), `${cwd}\n${sessionFile}\n`, 'utf8');

    const engine = createOhMyPiBackendEngine({} as never);
    const canonicalAgentDir = await realpath(agentDir);

    await expect(engine.terminalRuntimeSurface?.resolveTranscriptBinding?.({
      cwd,
      env: { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv,
      terminalId: 'pts-3',
    } as never)).resolves.toEqual({
      providerId: 'ohMyPi',
      source: {
        kind: 'ohMyPiAgentDir',
        agentDir: canonicalAgentDir,
      },
      providerSessionId: 'session-one',
      remoteSessionId: 'session-one',
    });
  });
});
