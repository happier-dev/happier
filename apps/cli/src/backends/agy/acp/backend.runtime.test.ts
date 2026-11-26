import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

import { createAgyAcpBackend } from './backend';

const CONNECTED_ACCOUNT_SELECTIONS = JSON.stringify([{ kind: 'profile', serviceId: 'antigravity', profileId: 'selected' }]);
const FILE_TOKEN_STORAGE = 'AGY_CLI_FORCE_FILE_TOKEN_STORAGE';

afterEach(() => vi.unstubAllEnvs());

/** A synthetic `agy` is the genuine provider-process boundary; it records its launch and reports `version`. */
async function writeAgyFixture(dir: string, version: string): Promise<string> {
  const script = writeAcpTestAgentScript({ dir, fileName: 'agy', source: `#!${process.execPath}
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(join(dir, 'launches.jsonl'))}, JSON.stringify({
      args: process.argv.slice(2), fileTokenStorage: process.env.${FILE_TOKEN_STORAGE} ?? null,
    }) + '\\n');
    const profile = process.argv.includes('--gemini-dir') ? process.argv[process.argv.indexOf('--gemini-dir') + 1] : null;
    const listStore = () => {
      try {
        return fs.readdirSync(require('node:path').join(profile, 'antigravity-cli', 'conversations'))
          .filter(name => name.endsWith('.db')).map(name => ({ sessionId: name.slice(0, -3), cwd: ${JSON.stringify(dir)} }));
      } catch { return []; }
    };
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.method !== 'initialize') fs.appendFileSync(${JSON.stringify(join(dir, 'requests.jsonl'))}, JSON.stringify(request.method) + '\\n');
      const result = request.method === 'initialize'
        ? { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: ${JSON.stringify(version)} },
            agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } }
        : request.method === 'session/list' ? { sessions: [{ sessionId: 'cli-conversation', cwd: ${JSON.stringify(dir)} }, ...listStore()] }
        : request.method === 'session/new' ? { sessionId: 'new-session' } : {};
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    });
  ` });
  await chmod(script, 0o755);
  return script;
}

async function readLaunches(dir: string): Promise<unknown[]> {
  return (await readFile(join(dir, 'launches.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

describe.skipIf(process.platform === 'win32')('Antigravity ACP launch', () => {
  it.each([
    { scenario: 'machine login uses the default profile', geminiHome: null, args: ['acp'] },
    { scenario: 'machine login honors GEMINI_HOME as the profile directory', geminiHome: 'profile', args: ['acp', '--gemini-dir', 'PROFILE'] },
  ])('$scenario and never forces file token storage', async ({ geminiHome, args }) => {
    await withTempDir('agy-launch-', async dir => {
      // An inherited value would silently move a machine login out of the OS keyring.
      vi.stubEnv(FILE_TOKEN_STORAGE, '1');
      const agy = await writeAgyFixture(dir, '1.5.18');
      const profile = join(dir, 'profile');
      const backend = await createAgyAcpBackend({ cwd: dir, env: {
        HAPPIER_AGY_PATH: agy, [FILE_TOKEN_STORAGE]: '1', ...(geminiHome ? { GEMINI_HOME: profile } : {}),
      } });
      try {
        await backend.startSession();
        expect(await readLaunches(dir)).toEqual([{ args: args.map(arg => arg === 'PROFILE' ? profile : arg), fileTokenStorage: null }]);
      } finally { await backend.dispose(); }
    });
  });

  it('starts connected accounts in their materialized profile with file token storage', async () => {
    await withTempDir('agy-launch-', async dir => {
      const agy = await writeAgyFixture(dir, '1.5.18');
      const home = join(dir, 'connected-home');
      const backend = await createAgyAcpBackend({ cwd: dir, env: {
        HAPPIER_AGY_PATH: agy, GEMINI_HOME: home, HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: CONNECTED_ACCOUNT_SELECTIONS,
      } });
      try {
        await backend.loadSession!('cli-conversation');
        expect(await readLaunches(dir)).toEqual([{
          args: ['acp', '--gemini-dir', home, '--app-data-dir', 'antigravity-cli'], fileTokenStorage: '1',
        }]);
      } finally { await backend.dispose(); }
    });
  });

  it('refuses connected accounts on an Antigravity CLI that cannot isolate them, before opening a session', async () => {
    await withTempDir('agy-launch-', async dir => {
      const agy = await writeAgyFixture(dir, '1.5.15');
      const backend = await createAgyAcpBackend({ cwd: dir, env: {
        HAPPIER_AGY_PATH: agy, GEMINI_HOME: join(dir, 'connected-home'), HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: CONNECTED_ACCOUNT_SELECTIONS,
      } });
      try {
        await expect(backend.startSession()).rejects.toThrow(/1\.5\.18 or newer.*agy update/);
        await expect(readFile(join(dir, 'requests.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { await backend.dispose(); }
    });
  });

  it('refuses a connected account whose profile was not materialized instead of using the machine login', async () => {
    await withTempDir('agy-launch-', async dir => {
      const agy = await writeAgyFixture(dir, '1.5.18');
      const backend = await createAgyAcpBackend({ cwd: dir, env: {
        HAPPIER_AGY_PATH: agy, HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: CONNECTED_ACCOUNT_SELECTIONS,
      } });
      try {
        await expect(backend.startSession()).rejects.toThrow(/profile/i);
        await expect(readFile(join(dir, 'launches.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { await backend.dispose(); }
    });
  });

  it.each([
    { account: 'machine login', connected: false },
    { account: 'connected account', connected: true },
  ])('continues a conversation the retired server created for the $account under the same id', async ({ connected }) => {
    await withTempDir('agy-launch-', async dir => {
      const agy = await writeAgyFixture(dir, '1.5.18');
      const profile = join(dir, 'profile');
      const id = 'legacy-conversation';
      const legacyFiles = [
        [`conversations/${id}.db`, 'legacy database'],
        [`conversations/${id}.db-wal`, 'legacy wal'],
        [`conversations/${id}.meta`, '{"cwd":"/work"}'],
        [`brain/${id}/task.md`, 'legacy artifact'],
      ] as const;
      for (const [path, contents] of legacyFiles) {
        await mkdir(join(profile, 'antigravity-acp', path, '..'), { recursive: true });
        await writeFile(join(profile, 'antigravity-acp', path), contents);
      }
      await writeFile(join(profile, 'antigravity-acp', 'conversations', 'other.db'), 'another conversation');
      const backend = await createAgyAcpBackend({ cwd: dir, env: {
        HAPPIER_AGY_PATH: agy, GEMINI_HOME: profile,
        ...(connected ? { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: CONNECTED_ACCOUNT_SELECTIONS } : {}),
      } });
      try {
        await expect(backend.loadSession!(id)).resolves.toMatchObject({ sessionId: id });
        expect(await readFile(join(dir, 'requests.jsonl'), 'utf8')).toContain('session/load');
        for (const [path, contents] of legacyFiles) {
          expect(await readFile(join(profile, 'antigravity-cli', path), 'utf8')).toBe(contents);
          expect(await readFile(join(profile, 'antigravity-acp', path), 'utf8')).toBe(contents);
        }
        await expect(readFile(join(profile, 'antigravity-cli', 'conversations', 'other.db'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { await backend.dispose(); }
    });
  });

  it('never replaces a conversation the CLI already continued', async () => {
    await withTempDir('agy-launch-', async dir => {
      const agy = await writeAgyFixture(dir, '1.5.18');
      const profile = join(dir, 'profile');
      for (const [store, contents] of [['antigravity-acp', 'legacy database'], ['antigravity-cli', 'continued database']]) {
        await mkdir(join(profile, store, 'conversations'), { recursive: true });
        await writeFile(join(profile, store, 'conversations', 'shared.db'), contents);
      }
      const backend = await createAgyAcpBackend({ cwd: dir, env: { HAPPIER_AGY_PATH: agy, GEMINI_HOME: profile } });
      try {
        await backend.loadSession!('shared');
        expect(await readFile(join(profile, 'antigravity-cli', 'conversations', 'shared.db'), 'utf8')).toBe('continued database');
      } finally { await backend.dispose(); }
    });
  });

  it('does not ask the CLI to open an unknown conversation as an empty session', async () => {
    await withTempDir('agy-launch-', async dir => {
      const agy = await writeAgyFixture(dir, '1.5.18');
      const backend = await createAgyAcpBackend({ cwd: dir, env: { HAPPIER_AGY_PATH: agy, GEMINI_HOME: dir } });
      try {
        await expect(backend.loadSession!('missing-conversation')).rejects.toThrow(/could not find/i);
        expect(await readFile(join(dir, 'requests.jsonl'), 'utf8')).not.toContain('session/load');
      } finally { await backend.dispose(); }
    });
  });
});
