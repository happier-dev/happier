import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';

const mocks = vi.hoisted(() => ({ ensureAgyAcpServerForLaunch: vi.fn() }));
// The pinned server install is a download/filesystem boundary owned and tested by its launch owner.
vi.mock('./ensureAgyAcpServerForLaunch', () => mocks);

import { createAgyAcpBackend } from './backend';

const PINNED_SERVER_ARGS = ['--uid='];

async function writeAcpAgent(dir: string, runtime: string): Promise<string> {
  const path = join(dir, runtime);
  await writeFile(path, `#!${process.execPath}
    require('node:fs').appendFileSync(${JSON.stringify(join(dir, 'launches.jsonl'))},
      JSON.stringify({ runtime: ${JSON.stringify(runtime)}, args: process.argv.slice(2) }) + '\\n');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
        : request.method === 'session/new' ? { sessionId: 'new-session' } : {};
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    });
  `);
  await chmod(path, 0o755);
  return path;
}

async function writePinnedServerConversation(geminiHome: string, id: string): Promise<void> {
  const store = join(geminiHome, 'antigravity-acp');
  await mkdir(join(store, 'conversations'), { recursive: true });
  await mkdir(join(store, 'brain', id), { recursive: true });
  await writeFile(join(store, 'conversations', `${id}.db`), 'conversation');
  await writeFile(join(store, 'conversations', `${id}.meta`), '{}');
}

describe('Antigravity ACP runtime selection', () => {
  beforeEach(() => mocks.ensureAgyAcpServerForLaunch.mockReset());

  it.each([
    { scenario: 'starts native-login sessions on the CLI ACP server', resume: null, connected: false, runtime: 'agy' },
    { scenario: 'resumes native-login sessions on the CLI ACP server', resume: 'cli-conversation', connected: false, runtime: 'agy' },
    { scenario: 'resumes conversations created by the pinned server on that server', resume: 'pinned-conversation', connected: false, runtime: 'agy-acp-server' },
    { scenario: 'keeps connected accounts on the pinned server', resume: null, connected: true, runtime: 'agy-acp-server' },
  ])('$scenario', async ({ resume, connected, runtime }) => {
    await withTempDir('agy-acp-runtime-', async dir => {
      const geminiHome = join(dir, 'gemini');
      await writePinnedServerConversation(geminiHome, 'pinned-conversation');
      const pinnedServer = await writeAcpAgent(dir, 'agy-acp-server');
      mocks.ensureAgyAcpServerForLaunch.mockResolvedValue({ command: pinnedServer, args: PINNED_SERVER_ARGS });
      const env = {
        HAPPIER_AGY_PATH: await writeAcpAgent(dir, 'agy'),
        GEMINI_HOME: geminiHome,
        ...(connected ? { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{ kind: 'profile', serviceId: 'antigravity', profileId: 'selected' }]) } : {}),
      };
      const backend = await createAgyAcpBackend({ cwd: dir, env });
      try {
        await (resume ? backend.loadSession!(resume) : backend.startSession());
        const launches = (await readFile(join(dir, 'launches.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(launches).toEqual([{ runtime, args: runtime === 'agy' ? ['acp'] : PINNED_SERVER_ARGS }]);
        if (runtime === 'agy') expect(mocks.ensureAgyAcpServerForLaunch).not.toHaveBeenCalled();
        else expect(mocks.ensureAgyAcpServerForLaunch).toHaveBeenCalledWith({ env });
      } finally { await backend.dispose(); }
    });
  });
});
