import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createAgyAcpBackend } from './backend';
import { installPinnedAgyAcpServerFixture, withIsolatedHappierHome } from './pinnedAgyAcpServer.testkit';

const CONNECTED_ACCOUNT_SELECTIONS = [{ kind: 'profile', serviceId: 'antigravity', profileId: 'selected' }];

function acpAgentSource(dir: string, runtime: string): string {
  return `#!${process.execPath}
    require('node:fs').appendFileSync(${JSON.stringify(join(dir, 'launches.jsonl'))},
      JSON.stringify({ runtime: ${JSON.stringify(runtime)}, args: process.argv.slice(2) }) + '\\n');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
        : request.method === 'session/new' ? { sessionId: 'new-session' } : {};
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    });
  `;
}

async function writePinnedServerConversation(geminiHome: string, id: string): Promise<void> {
  const store = join(geminiHome, 'antigravity-acp');
  await mkdir(join(store, 'conversations'), { recursive: true });
  await mkdir(join(store, 'brain', id), { recursive: true });
  await writeFile(join(store, 'conversations', `${id}.db`), 'conversation');
  await writeFile(join(store, 'conversations', `${id}.meta`), '{}');
}

describe('Antigravity ACP runtime selection', () => {
  it.each([
    { scenario: 'starts native-login sessions on the CLI ACP server', resume: null, connected: false, runtime: 'agy' },
    { scenario: 'resumes native-login sessions on the CLI ACP server', resume: 'cli-conversation', connected: false, runtime: 'agy' },
    { scenario: 'resumes conversations created by the pinned server on that server', resume: 'pinned-conversation', connected: false, runtime: 'agy-acp-server' },
    { scenario: 'keeps connected accounts on the pinned server', resume: null, connected: true, runtime: 'agy-acp-server' },
  ])('$scenario', async ({ resume, connected, runtime }) => {
    await withIsolatedHappierHome(async dir => {
      const geminiHome = join(dir, 'gemini');
      await writePinnedServerConversation(geminiHome, 'pinned-conversation');
      const pinnedServer = await installPinnedAgyAcpServerFixture(acpAgentSource(dir, 'agy-acp-server'));
      const agy = join(dir, 'agy.cjs');
      await writeFile(agy, acpAgentSource(dir, 'agy'));
      await chmod(agy, 0o755);
      const backend = await createAgyAcpBackend({ cwd: dir, env: {
        HAPPIER_AGY_PATH: agy,
        GEMINI_HOME: geminiHome,
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify(connected ? CONNECTED_ACCOUNT_SELECTIONS : []),
      } });
      try {
        await (resume ? backend.loadSession!(resume) : backend.startSession());
        const launches = (await readFile(join(dir, 'launches.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(launches).toEqual([{ runtime, args: runtime === 'agy' ? ['acp'] : pinnedServer.args }]);
      } finally { await backend.dispose(); }
    });
  });
});
