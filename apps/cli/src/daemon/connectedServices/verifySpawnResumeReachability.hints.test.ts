import fileSystem, { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from './connectedServiceChildEnvironment';
import { verifySpawnResumeReachability } from './verifySpawnResumeReachability';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: (...args: Parameters<typeof actual.readdir>) => actual.readdir(...args) };
});

const id = '019e7327-46cc-7dca-bb14-8473727db321';
const cases = [
  { agentId: 'claude', path: `projects/-project/${id}.jsonl` },
  { agentId: 'codex', path: `sessions/2026/11/09/rollout-2026-11-09T06-00-00-${id}.jsonl` },
  { agentId: 'pi', path: `sessions/-project/2026-11-09T06-00-00-000Z_${id}.jsonl` },
  { agentId: 'ohMyPi', path: `sessions/-project/2026-11-09T06-00-00-000Z_${id}.jsonl` },
  { agentId: 'antigravity', path: `antigravity-acp/conversations/${id}.db` },
] as const;

describe('spawn resume hints through every installed reachability hook', () => {
  let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
  beforeAll(async () => {
    runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.claude', 'happier.agent.codex', 'happier.agent.pi',
        'happier.agent.ohmypi', 'happier.agent.antigravity'] } });
  });
  afterAll(async () => { await runtime?.dispose(); await pluginReloadController.shutdown(); });

  it.each(cases)('$agentId uses only a target-contained matching file and falls back for unusable hints', async ({ agentId, path }) => {
    const root = await mkdtemp(join(tmpdir(), 'spawn-resume-hints-'));
    const target = join(root, 'target');
    const candidate = join(target, path);
    const wrong = join(dirname(candidate), 'unrelated.jsonl');
    const outside = join(root, 'outside', path);
    try {
      await mkdir(dirname(candidate), { recursive: true });
      await mkdir(dirname(outside), { recursive: true });
      await writeFile(candidate, `{"type":"session","id":"${id}"}\n`);
      await writeFile(outside, `{"type":"session","id":"${id}"}\n`);
      await writeFile(wrong, '{"type":"session","id":"different-session"}\n');
      if (agentId === 'antigravity') {
        await writeFile(join(dirname(candidate), `${id}.meta`), '{}');
        await mkdir(join(target, 'antigravity-acp', 'brain', id), { recursive: true });
      }
      const verify = (hint: string) => verifySpawnResumeReachability({ agentId, vendorResumeId: id,
        materializedEnv: { [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: target },
        candidatePersistedSessionFile: hint,
      });
      const traversal = vi.spyOn(fileSystem, 'readdir');
      syncBuiltinESMExports();
      try {
        await expect(verify(candidate)).resolves.toEqual({ ok: true, resolvedPath: candidate });
        expect(traversal.mock.calls).toHaveLength(0);
        for (const hint of [join(root, 'stale.jsonl'), outside, wrong]) {
          traversal.mockClear();
          await expect(verify(hint)).resolves.toEqual({ ok: true, resolvedPath: candidate });
          expect(traversal.mock.calls.length).toBeGreaterThan(0);
        }
        await rm(candidate);
        // A correct-looking source file must never prove target reachability.
        await expect(verify(outside)).resolves.toMatchObject({ ok: false });
      } finally { traversal.mockRestore(); syncBuiltinESMExports(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
