import { afterEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { registerMachinePromptAssetTransferRpcHandlers } from '@/api/machine/rpcHandlers.promptAssetTransfers';
import { scanNativeSkillRoots } from './scanNativeSkillRoots';
import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { FoundSkillBundleV1Schema } from '@happier-dev/protocol/prompts/library/skills/foundSkillTransferV1';
import { readFoundSkillBundle } from './resolveFoundSkillDownloadSource';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });

it('reads a local Found bundle from the invoking hosted Session home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-found-session-')); homes.push(home);
  const path = join(home, '.skills', 'session-skill');
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), '---\nname: session-skill\n---\nSession body');
  const bundle = await runAddedHostedSession({ environment: { NODE_ENV: 'test', HOME: home, USERPROFILE: home },
    workingDirectory: home, end() {} }, () => readFoundSkillBundle({ request: { path: '~/.skills/session-skill' },
      agents: [{ agentId: 'reader', nativeRoots: { user: [['.skills']] } }] }));
  expect(bundle).toMatchObject({ name: 'session-skill', path, agents: ['reader'] });
});

it('rejects malformed bytes and unsafe file paths at the strict transfer consumer', () => {
  const payload = { name: 'fixture', path: '/root/fixture', agents: ['test.skill-reader'], pluginOwned: null,
    files: [{ path: 'SKILL.md', contentBase64: Buffer.from('Body').toString('base64'), contentKind: 'utf8' }] };
  expect(FoundSkillBundleV1Schema.safeParse(payload).success).toBe(true);
  expect(FoundSkillBundleV1Schema.safeParse({ ...payload, files: [...payload.files,
    { path: '../escape', contentBase64: '', contentKind: 'binary' }] }).success).toBe(false);
  expect(FoundSkillBundleV1Schema.safeParse({ ...payload, files: [{ ...payload.files[0], contentBase64: '%%%bad' }] }).success).toBe(false);
  expect(FoundSkillBundleV1Schema.safeParse({ ...payload, arbitraryAuthority: true }).success).toBe(false);
});

it('keeps the Agent provenance of a default user-root scan when another Agent declares that root only for projects', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-found-provenance-')); homes.push(home);
  const path = join(home, '.skills', 'fixture');
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), '---\nname: fixture\n---\nBody');
  const agents = [{ agentId: 'user-reader', nativeRoots: { user: [['.skills']] } },
    { agentId: 'project-reader', nativeRoots: { project: [['.skills']] } }];
  const scan = await scanNativeSkillRoots({ purpose: 'found', home, agents });
  const payload = await readFoundSkillBundle({ request: { path }, home, agents });
  expect(payload.agents).toEqual(scan.items[0]?.agents);
});

it('reads real scanner paths of every scope through the registered encrypted download lifecycle', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-found-download-')); homes.push(home);
  const agents = [{ agentId: 'test.skill-reader', nativeRoots: {
    user: [['.skills']], project: [['.project-skills']],
    plugin: [['.plugins', '*', '{plugin}', '*', 'skills']],
  } }];
  const repository = join(home, 'repo');
  await mkdir(join(repository, '.git'), { recursive: true });
  for (const root of [join(home, '.skills'), join(repository, '.project-skills'), join(home, '.plugins', 'market', 'plugin', 'v1', 'skills')]) {
    const path = join(root, 'fixture');
    await mkdir(join(path, 'scripts'), { recursive: true });
    await writeFile(join(path, 'SKILL.md'), '---\nname: fixture\ndescription: A fixture\n---\nBody');
    await writeFile(join(path, 'scripts', 'run.sh'), '#!/bin/sh\necho fixture');
    await chmod(join(path, 'scripts', 'run.sh'), 0o755);
  }
  const scan = await scanNativeSkillRoots({ purpose: 'found', agents, home, directory: repository });
  expect(scan.items.map(item => item.scope).sort()).toEqual(['plugin', 'project', 'user']);
  const handlers = new Map<string, (data: unknown) => unknown | Promise<unknown>>();
  const registrar: RpcHandlerRegistrar = { registerHandler<TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) {
    // The transport presents unknown input; the real handler owns decoding.
    handlers.set(method, data => handler(data as TRequest));
  } };
  const registration = registerMachinePromptAssetTransferRpcHandlers({ rpcHandlerManager: registrar,
    foundSkills: { home, agents } });
  const keyPair = createTransferRecipientKeyPair();
  const invoke = async (method: string, data: unknown) => await handlers.get(method)!(data);
  try {
    for (const item of scan.items) {
      const init = await invoke(RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
        { path: item.path, recipientPublicKeyBase64: keyPair.recipientPublicKeyBase64 });
      expect(init).toMatchObject({ success: true });
      if (!init || typeof init !== 'object' || !('downloadId' in init) || typeof init.downloadId !== 'string') throw new Error('Download init failed');
      const buffers: Buffer[] = [];
      for (let index = 0;; index += 1) {
        const chunk = await invoke(RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK, { downloadId: init.downloadId, index });
        if (!chunk || typeof chunk !== 'object' || !('payloadBase64' in chunk)) throw new Error('Encrypted chunk missing');
        if (typeof chunk.payloadBase64 !== 'string' || !('encryptedDataKeyEnvelopeBase64' in chunk)
          || typeof chunk.encryptedDataKeyEnvelopeBase64 !== 'string') throw new Error('Invalid encrypted chunk');
        buffers.push(Buffer.from(decryptEncryptedTransferChunkEnvelope({ payloadBase64: chunk.payloadBase64,
          encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64, transferId: init.downloadId, sequence: index,
          recipientSecretKeySeed: keyPair.recipientSecretKeySeed })));
        if ('isLast' in chunk && chunk.isLast) break;
      }
      const payload = FoundSkillBundleV1Schema.parse(JSON.parse(Buffer.concat(buffers).toString('utf8')));
      expect(payload).toMatchObject({ name: item.name, path: item.path, agents: item.agents, pluginOwned: item.pluginOwned });
      expect(payload.files.map(file => file.path)).toEqual(['SKILL.md', 'scripts/run.sh']);
      if (process.platform !== 'win32') expect(payload.files[1]?.unixMode).toBe(0o755);
      expect(await invoke(RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE, { downloadId: init.downloadId })).toEqual({ success: true });
      expect(registration.downloadStore.listDownloadSessionIds()).toEqual([]);
    }
    expect(await invoke(RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
      { path: join(home, 'unscanned'), recipientPublicKeyBase64: keyPair.recipientPublicKeyBase64 })).toEqual({ success: false, error: 'not_found', code: 'not_found' });
    // Preserve the raw dot segment: path.join normalizes it before transport.
    expect(await invoke(RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
      { path: `${home}/.skills/../.skills/fixture`, recipientPublicKeyBase64: keyPair.recipientPublicKeyBase64 })).toEqual({ success: false, error: 'not_found', code: 'not_found' });
  } finally { await registration.dispose(); }
});
