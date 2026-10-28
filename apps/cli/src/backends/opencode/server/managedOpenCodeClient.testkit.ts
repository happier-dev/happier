import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

import { configuration } from '@/configuration';
import { prepareIsolatedDaemonTestHome } from '@/daemon/testkit/realIntegration.testkit';
import { spawnDetachedInlineNodeTestProcess, waitForProcessExit } from '@/testkit/process/spawn';

import { createOpenCodeServerRuntimeClient } from './client';
import { resolveOpenCodeManagedServerLaunchFingerprint } from './openCodeManagedServerEnv';
import { getOpenCodeServerProcessInfoBestEffort } from './openCodeServerProcessState';
import { readSharedManagedOpenCodeServerStateBestEffort, resolveSharedManagedOpenCodeServerStatePathForEnv, type SharedManagedOpenCodeServerState } from './sharedManagedServer';

/** Real owner files and an owned OS process; tests replace only the provider HTTP boundary. */
export async function createManagedOpenCodeClientFixture() {
  const home = await prepareIsolatedDaemonTestHome({ prefix: 'happier-opencode-client-', extraEnv: {
    HAPPIER_OPENCODE_SERVER_URL: undefined,
    HAPPIER_OPENCODE_SERVER_STATE_PATH: undefined,
    HAPPIER_OPENCODE_SERVER_XDG_ROOT_DIR: undefined,
    HAPPIER_OPENCODE_PATH: undefined,
  } });
  const providerPath = join(home.homeDir, 'provider.cjs');
  const clients: Awaited<ReturnType<typeof createOpenCodeServerRuntimeClient>>[] = [];
  let providerPid: number | undefined;
  let cleanup: Promise<void> | undefined;
  const stopProvider = async () => {
    if (!providerPid) return;
    try { process.kill(providerPid, 'SIGKILL'); } catch {}
    if (!await waitForProcessExit(providerPid, { timeoutMs: 1_000 })) {
      throw new Error('Owned OpenCode fixture process did not exit');
    }
  };
  const close = () => cleanup ??= (async () => {
    const replacement = await readSharedManagedOpenCodeServerStateBestEffort();
    try {
      for (const client of clients) await client.dispose();
    } finally {
      try {
        if (replacement && replacement.pid !== providerPid) {
          const info = await getOpenCodeServerProcessInfoBestEffort(replacement.pid);
          if (info?.cmd.includes(providerPath)) {
            try { process.kill(replacement.pid, 'SIGKILL'); } catch {}
            if (!await waitForProcessExit(replacement.pid, { timeoutMs: 1_000 })) {
              throw new Error('Replacement OpenCode fixture process did not exit');
            }
          }
        }
      } finally {
        try { await stopProvider(); } finally { await home.restore(); }
      }
    }
  })();
  try {
    // Replacement recovery uses the real launch owner with a fake provider executable.
    await writeFile(providerPath, `#!${process.execPath}\nsetInterval(() => {}, 1 << 30);\n`, { mode: 0o755 });
    process.env.HAPPIER_OPENCODE_PATH = providerPath;
    providerPid = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1 << 30)').pid;
    if (!providerPid) throw new Error('OpenCode provider fixture did not start');
    const pid = providerPid;
    const statePath = resolveSharedManagedOpenCodeServerStatePathForEnv(process.env);
    const info = await getOpenCodeServerProcessInfoBestEffort(pid);
    const birth = readProcessInstanceFingerprintSync(pid);
    if (!info || !birth) throw new Error('OpenCode provider fixture identity unavailable');
    const initialState: SharedManagedOpenCodeServerState = {
      v: 2, baseUrl: 'http://127.0.0.1:9999', pid, startedAtMs: 1, status: 'ready',
      launchEnvFingerprint: resolveOpenCodeManagedServerLaunchFingerprint({ baseEnv: process.env, xdgRootDir: null, isolateConfig: false }),
      ownerToken: 'gen-A', processInstanceFingerprint: birth,
      expectedCmdlineHash: createHash('sha256').update(info.cmd).digest('hex'),
      activeServerDir: configuration.activeServerDir, daemonInstanceId: 'fixture-daemon',
    };
    const publish = async (overrides: Partial<SharedManagedOpenCodeServerState> = {}) => {
      const state = { ...initialState, ...overrides };
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(`${statePath}.fixture`, JSON.stringify(state));
      await rename(`${statePath}.fixture`, statePath);
      return state;
    };
    await publish();
    return {
      homeDir: home.homeDir, pid, statePath, publish, stopProvider, close,
      removeState: async () => { await rm(statePath, { force: true }); },
      createClient: async (params: Parameters<typeof createOpenCodeServerRuntimeClient>[0]) => {
        const client = await createOpenCodeServerRuntimeClient(params);
        clients.push(client);
        return client;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Fetch-level SSE fixture keeps the parser, subscriptions, reconnect loop and abort wiring real. */
export function createOpenCodeSseResponse(signal?: AbortSignal | null) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let settled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { settled = true; },
  });
  const close = () => {
    if (settled) return;
    settled = true;
    controller.close();
  };
  signal?.addEventListener('abort', close, { once: true });
  return {
    response: new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    send: (event: unknown, id?: string) => {
      controller.enqueue(new TextEncoder().encode(`${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(event)}\n\n`));
    },
    close,
    fail: () => {
      if (settled) return;
      settled = true;
      controller.error(new TypeError('fetch failed'));
    },
  };
}
