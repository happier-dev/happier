import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { adoptAntigravityLegacyConversation } from './legacyConversation.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function profile(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `agy-legacy-${name}-`));
  roots.push(root);
  return root;
}

async function writeLegacy(root: string, id: string): Promise<void> {
  await mkdir(join(root, 'antigravity-acp', 'conversations'), { recursive: true });
  await mkdir(join(root, 'antigravity-acp', 'brain', id, '.system_generated', 'logs'), { recursive: true });
  await writeFile(join(root, 'antigravity-acp', 'conversations', `${id}.db`), 'legacy conversation');
  await writeFile(join(root, 'antigravity-acp', 'conversations', `${id}.db-wal`), 'uncheckpointed pages');
  await writeFile(join(root, 'antigravity-acp', 'conversations', `${id}.meta`), '{"cwd":"/work"}');
  await writeFile(join(root, 'antigravity-acp', 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl'), '{}\n');
}

it('adopts a retired-server conversation into the native store under the same id and keeps the source', async () => {
  const home = await profile('home');
  await writeLegacy(home, 'legacy-1');

  await expect(adoptAntigravityLegacyConversation({ geminiDir: home, conversationId: 'legacy-1', machineGeminiDir: home }))
    .resolves.toBe('adopted');

  const native = join(home, 'antigravity-cli');
  expect(await readFile(join(native, 'conversations', 'legacy-1.db'), 'utf8')).toBe('legacy conversation');
  expect(await readFile(join(native, 'conversations', 'legacy-1.db-wal'), 'utf8')).toBe('uncheckpointed pages');
  expect(await readFile(join(native, 'conversations', 'legacy-1.meta'), 'utf8')).toBe('{"cwd":"/work"}');
  expect(await readFile(join(native, 'brain', 'legacy-1', '.system_generated', 'logs', 'transcript_full.jsonl'), 'utf8')).toBe('{}\n');
  expect(await readFile(join(home, 'antigravity-acp', 'conversations', 'legacy-1.db'), 'utf8')).toBe('legacy conversation');
  await expect(adoptAntigravityLegacyConversation({ geminiDir: home, conversationId: 'legacy-1', machineGeminiDir: home }))
    .resolves.toBe('native');
});

it('adopts from the machine profile into a connected profile and never overwrites native history', async () => {
  const machine = await profile('machine');
  const account = await profile('account');
  await writeLegacy(machine, 'shared-1');
  await mkdir(join(account, 'antigravity-cli', 'brain', 'shared-1'), { recursive: true });
  await writeFile(join(account, 'antigravity-cli', 'brain', 'shared-1', 'native.md'), 'native');

  await expect(adoptAntigravityLegacyConversation({ geminiDir: account, conversationId: 'shared-1', machineGeminiDir: machine }))
    .resolves.toBe('adopted');
  expect(await readFile(join(account, 'antigravity-cli', 'conversations', 'shared-1.db'), 'utf8')).toBe('legacy conversation');
  expect(await readFile(join(account, 'antigravity-cli', 'brain', 'shared-1', 'native.md'), 'utf8')).toBe('native');

  await writeFile(join(account, 'antigravity-cli', 'conversations', 'shared-1.db'), 'native continued');
  await expect(adoptAntigravityLegacyConversation({ geminiDir: account, conversationId: 'shared-1', machineGeminiDir: machine }))
    .resolves.toBe('native');
  expect(await readFile(join(account, 'antigravity-cli', 'conversations', 'shared-1.db'), 'utf8')).toBe('native continued');
});

it('ignores unknown and path-shaped ids', async () => {
  const home = await profile('empty');
  await expect(adoptAntigravityLegacyConversation({ geminiDir: home, conversationId: 'missing', machineGeminiDir: home }))
    .resolves.toBe('absent');
  await expect(adoptAntigravityLegacyConversation({ geminiDir: home, conversationId: '../escape', machineGeminiDir: home }))
    .resolves.toBe('absent');
});
