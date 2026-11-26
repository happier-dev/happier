import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { configuration, reloadConfiguration } from '@/configuration';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';
import { resolveConnectedServicesMaterializationBaseDir } from '@/daemon/connectedServices/materialize/resolveConnectedServicesMaterializationBaseDir';
import { resolveConnectedServiceMaterializedRootDir } from '@/daemon/connectedServices/materialize/resolveConnectedServiceMaterializedRootDir';
import { resolveRequesterSessionRuntimeDirectories } from '@/daemon/sessionEncryption/requesterSessionRuntimeDirectories';
import { registerMachineSessionHandoffRpcHandlers } from './handlers';

/**
 * A Use guest's own Codex Session runs on a shared Machine with the Codex home
 * its launch owner materialized under the guest Account's roots, and the Codex
 * runtime records that home in the Session's runtime descriptor. Export reads
 * exactly that recorded home: never the Machine owner's home, never a scan.
 *
 * Real: handoff RPC registration, the lifecycle requester gate, start
 * orchestration, the host export owner, the admitted Codex plugin exporter,
 * the requester root layout and the source export store, over a temporary
 * filesystem. Stand-ins: the Home Session read (`loadSessionMetadata`), the
 * native process Stop, and the requester custody store/Home behind
 * `requesterSessionRuntime`.
 */
const enabledServerFeaturesSnapshot = {
  status: 'ready' as const,
  features: FeaturesResponseSchema.parse({
    features: {
      sessions: { enabled: true, handoff: { enabled: true } },
      machines: {
        enabled: true,
        transfer: {
          enabled: true,
          directPeer: { enabled: true },
          serverRouted: { enabled: true },
        },
      },
    },
    capabilities: {},
  }),
};

const SERVER_ID = 'server-1';
const MACHINE_ID = 'machine-source';
const INSTALLATION_ID = 'installation-1';
const OWNER_ACCOUNT = 'owner-account';
const GUEST_ACCOUNT = 'guest-account';
const GUEST_SESSION = 'guest-session';
const OWNER_SESSION = 'owner-session';
const THREAD = 'thread-shared-machine';

function rollout(event: string, meta: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'session_meta', payload: { id: THREAD, ...meta } })}\n${JSON.stringify({ event })}\n`;
}

async function writeRollout(codexHome: string, event: string, meta: Record<string, unknown> = {}): Promise<void> {
  const dir = join(codexHome, 'sessions', '2026', '11', '26');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `rollout-2026-11-26T10-00-00-${THREAD}.jsonl`),
    rollout(event, meta),
  );
}

/** The descriptor shape the Codex runtime publishes at launch: its CODEX_HOME as `homePath`. */
function sessionMetadata(
  path: string,
  homePath?: string,
): Record<string, unknown> {
  return {
    machineId: MACHINE_ID,
    path,
    runtimeDescriptorV1: {
      v: 1,
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        providerSessionId: THREAD,
        ...(homePath ? { homePath } : {}),
      },
    },
    nativeResumeIdentityV1: { v: 1, vendorResumeId: THREAD },
  };
}

describe('session handoff start — a requester Session exports from its recorded Codex home', () => {
  let root: string;
  let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
  const previousHome = process.env.HAPPIER_HOME_DIR;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'handoff-requester-export-root-'));
    process.env.HAPPIER_HOME_DIR = join(root, 'happier-home');
    reloadConfiguration();
    runtime = await createAdmittedPluginRuntimeFixture({
      controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.codex'] },
    });
  });

  afterAll(async () => {
    await runtime?.dispose();
    if (previousHome === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHome;
    reloadConfiguration();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  /** The guest's Codex home exactly as the launch owner lays it out for a requester Session. */
  function guestCodexHome(activeServerDir: string): string {
    const directories = resolveRequesterSessionRuntimeDirectories({
      activeServerDir,
      connectedServicesMaterializationBaseDir:
        resolveConnectedServicesMaterializationBaseDir(
          configuration.happyHomeDir,
        ),
      attribution: { accountId: GUEST_ACCOUNT },
    });
    return resolveConnectedServiceMaterializedRootDir({
      baseDir: directories.connectedServicesMaterializationBaseDir,
      agentId: 'codex',
      materializationKey: GUEST_SESSION,
    });
  }

  async function startHandoff(
    input: Readonly<{
      activeServerDir: string;
      sessionId: string;
      metadata: Record<string, unknown>;
      /** `custodianBootstrap`: the custodian's own Session carrying a bound bootstrap (host onboarding). */
      actor: 'owner' | 'guest' | 'custodianBootstrap';
    }>,
  ) {
    // The daemon process environment is the Machine owner's.
    vi.stubEnv('CODEX_HOME', join(input.activeServerDir, 'owner-codex-home'));
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    const rpcHandlerManager = {
      registerHandler: (
        method: string,
        handler: RpcHandler<unknown, unknown>,
      ) => handlers.set(method, handler),
    } as unknown as RpcHandlerManager;
    const loadSessionMetadata = vi.fn(async () => input.metadata);
    const stop = vi.fn(async () => 'stopped' as const);
    const attribution = {
      serverId: SERVER_ID,
      accountId: GUEST_ACCOUNT,
      machineId: MACHINE_ID,
      installationId: INSTALLATION_ID,
    };
    // Custody-store stand-in: the guest's admitted runtime is bound to the guest's own Session only.
    const bootstrap = {
      attribution,
      allowNativeAccountCredentials: false,
      getBoundSessionId: () => GUEST_SESSION,
      isCurrent: async () => true,
    };
    // The admission owner marks the custodian's own bootstrap with native-credential access.
    const custodianBootstrap = {
      attribution: { ...attribution, accountId: OWNER_ACCOUNT },
      allowNativeAccountCredentials: true,
      getBoundSessionId: () => OWNER_SESSION,
      isCurrent: async () => true,
    };
    const requesterRuntime = { bootstrap, isCurrent: async () => true };
    registerMachineSessionHandoffRpcHandlers({
      rpcHandlerManager,
      runtimeConfig: { activeServerDir: input.activeServerDir },
      runtimeDependencies: { createUuid: () => 'test' },
      loadSessionMetadata,
      stopSessionForHandoff: stop,
      resolveServerFeaturesSnapshot: () => enabledServerFeaturesSnapshot,
      machineTransferChannel: {
        onEnvelope: () => () => undefined,
        sendEnvelope: () => undefined,
      },
      requesterSessionRuntime: {
        serverId: SERVER_ID,
        resolve: async () => requesterRuntime,
        release: async () => undefined,
      } as unknown as NonNullable<
        Parameters<
          typeof registerMachineSessionHandoffRpcHandlers
        >[0]['requesterSessionRuntime']
      >,
    });
    const context = (input.actor === 'guest'
      ? {
          machineAdmission: {
            actorAccountId: GUEST_ACCOUNT,
            custodianAccountId: OWNER_ACCOUNT,
            machineId: MACHINE_ID,
            installationId: INSTALLATION_ID,
            encryptionMode: 'plain',
          },
          verifyMachineAdmissionCurrent: async () => true,
        }
      : input.actor === 'custodianBootstrap'
        ? { requesterSessionBootstrap: custodianBootstrap }
        : {}) as unknown as RpcHandlerContext;
    const result = await handlers.get(
      RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3,
    )!(
      {
        sessionId: input.sessionId,
        sourceMachineId: MACHINE_ID,
        targetMachineId: 'machine-target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['server_routed_stream'],
        negotiatedTransportStrategy: 'server_routed_stream',
      },
      context,
    );
    const abort = handlers.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3);
    return { result, loadSessionMetadata, stop, abort };
  }

  async function exportedEvent(activeServerDir: string): Promise<string> {
    const record = await createSessionHandoffSourceExportStore({ activeServerDir }).load('handoff_test');
    if (!record?.agentBundle) throw new Error('Source did not publish its native export');
    return await readFile(record.agentBundle.filePath, 'utf8');
  }

  it("exports a Use guest's own Session from the Codex home recorded at its launch, not the owner's home", async () => {
    const activeServerDir = await mkdtemp(join(root, 'guest-own-'));
    const guestHome = guestCodexHome(activeServerDir);
    await writeRollout(guestHome, 'guest-transcript');
    const { result, stop, abort } = await startHandoff({
      activeServerDir,
      sessionId: GUEST_SESSION,
      metadata: sessionMetadata(activeServerDir, guestHome),
      actor: 'guest',
    });
    try {
      // On failure this names the refusal (the observed H04 message).
      expect(result).not.toHaveProperty('error');
      expect(result).toMatchObject({
        handoffId: 'handoff_test',
        status: { status: 'pending' },
      });
      expect(stop).toHaveBeenCalledTimes(1);
      expect(await exportedEvent(activeServerDir)).toContain(
        'guest-transcript',
      );
    } finally {
      await abort?.({ handoffId: 'handoff_test' });
    }
  });

  it("never substitutes the owner's same-id rollout when the guest's recorded home is gone", async () => {
    const activeServerDir = await mkdtemp(join(root, 'guest-gone-'));
    await writeRollout(join(activeServerDir, 'owner-codex-home'), 'owner-transcript');
    // The requester store is Machine-wide; this Session's recorded home is gone.
    await rm(guestCodexHome(activeServerDir), { recursive: true, force: true });
    const { result } = await startHandoff({ activeServerDir, sessionId: GUEST_SESSION,
      metadata: sessionMetadata(activeServerDir, guestCodexHome(activeServerDir)), actor: 'guest' });
    expect(result).toMatchObject({ ok: false, errorCode: 'source_export_failed',
      failureCause: { phase: 'session_handoff.source_export' } });
    // The requester reads the closed message; the cause stays in the Machine's daemon log.
    expect(result).toMatchObject({ error: 'Session handoff export failed: handoff_failed' });
    expect(await createSessionHandoffSourceExportStore({ activeServerDir }).load('handoff_test'))
      .not.toMatchObject({ agentBundle: expect.anything() });
  });

  it("refuses a guest Session whose recorded home is the Machine owner's home", async () => {
    const activeServerDir = await mkdtemp(join(root, 'guest-forged-'));
    const ownerHome = join(activeServerDir, 'owner-codex-home');
    await writeRollout(ownerHome, 'owner-transcript');
    const { result } = await startHandoff({
      activeServerDir,
      sessionId: GUEST_SESSION,
      metadata: sessionMetadata(activeServerDir, ownerHome),
      actor: 'guest',
    });
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'source_export_failed',
      failureCause: { phase: 'session_handoff.source_export' },
    });
    expect(
      await createSessionHandoffSourceExportStore({ activeServerDir }).load(
        'handoff_test',
      ),
    ).not.toMatchObject({ agentBundle: expect.anything() });
  });

  it("refuses a guest's handoff of another person's Session before any Session metadata or home is read", async () => {
    const activeServerDir = await mkdtemp(join(root, 'guest-foreign-'));
    await writeRollout(
      join(activeServerDir, 'owner-codex-home'),
      'owner-transcript',
    );
    const { result, loadSessionMetadata, stop } = await startHandoff({
      activeServerDir,
      sessionId: OWNER_SESSION,
      metadata: sessionMetadata(
        activeServerDir,
        join(activeServerDir, 'owner-codex-home'),
      ),
      actor: 'guest',
    });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain('owner-transcript');
    expect(loadSessionMetadata).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(
      await createSessionHandoffSourceExportStore({ activeServerDir }).load(
        'handoff_test',
      ),
    ).toBeNull();
  });

  it.each([{ recorded: true }, { recorded: false }])(
    "exports the Machine owner's own Session from its home (recorded=$recorded)",
    async ({ recorded }) => {
      const activeServerDir = await mkdtemp(join(root, 'owner-own-'));
      const ownerHome = join(activeServerDir, 'owner-codex-home');
      await writeRollout(ownerHome, 'owner-transcript');
      const { result, abort } = await startHandoff({
        activeServerDir,
        sessionId: OWNER_SESSION,
        metadata: sessionMetadata(
          activeServerDir,
          recorded ? ownerHome : undefined,
        ),
        actor: 'owner',
      });
      try {
        expect(result).toMatchObject({
          handoffId: 'handoff_test',
          status: { status: 'pending' },
        });
        expect(await exportedEvent(activeServerDir)).toContain(
          'owner-transcript',
        );
      } finally {
        await abort?.({ handoffId: 'handoff_test' });
      }
    },
  );
  it("exports the custodian's own Session that carries its own bound bootstrap, from the daemon home", async () => {
    const activeServerDir = await mkdtemp(join(root, 'custodian-bootstrap-'));
    const ownerHome = join(activeServerDir, 'owner-codex-home');
    await writeRollout(ownerHome, 'owner-transcript');
    const { result, abort } = await startHandoff({ activeServerDir, sessionId: OWNER_SESSION,
      metadata: sessionMetadata(activeServerDir, ownerHome), actor: 'custodianBootstrap' });
    try {
      expect(result).not.toHaveProperty('error');
      expect(await exportedEvent(activeServerDir)).toContain('owner-transcript');
    } finally { await abort?.({ handoffId: 'handoff_test' }); }
  });

  it('gives a requester one closed refusal for any home its metadata names, keeping the code', async () => {
    const missingDir = await mkdtemp(join(root, 'oracle-missing-'));
    const missing = await startHandoff({ activeServerDir: missingDir, sessionId: GUEST_SESSION,
      metadata: sessionMetadata(missingDir, join(missingDir, 'nope')), actor: 'guest' });
    const emptyDir = await mkdtemp(join(root, 'oracle-empty-'));
    await mkdir(join(emptyDir, 'exists-empty'), { recursive: true });
    const empty = await startHandoff({ activeServerDir: emptyDir, sessionId: GUEST_SESSION,
      metadata: sessionMetadata(emptyDir, join(emptyDir, 'exists-empty')), actor: 'guest' });
    const paginatedDir = await mkdtemp(join(root, 'oracle-paginated-'));
    const ownerHome = join(paginatedDir, 'owner-codex-home');
    await writeRollout(ownerHome, 'owner-transcript', { history_mode: 'paginated',
      history_base: { thread_id: 'OWNER-PRIVATE-BASE-ID', end_byte_offset: 10, end_ordinal_exclusive: 1 } });
    const paginated = await startHandoff({ activeServerDir: paginatedDir, sessionId: GUEST_SESSION,
      metadata: sessionMetadata(paginatedDir, ownerHome), actor: 'guest' });
    for (const { result } of [missing, empty, paginated]) {
      expect(result).toMatchObject({ ok: false, errorCode: 'source_export_failed',
        failureCause: { phase: 'session_handoff.source_export', errorCode: 'handoff_failed' } });
    }
    expect(JSON.stringify(paginated.result)).not.toContain('OWNER-PRIVATE-BASE-ID');
    expect(JSON.stringify(paginated.result)).not.toContain('owner-transcript');
    const errorOf = (value: unknown) => (value as { error?: unknown }).error;
    expect(errorOf(missing.result)).toBe(errorOf(empty.result));
    expect(errorOf(paginated.result)).toBe(errorOf(missing.result));
  });
  it("names the gone recorded home to the Machine's own Session", async () => {
    const activeServerDir = await mkdtemp(join(root, 'owner-gone-'));
    const { result } = await startHandoff({ activeServerDir, sessionId: OWNER_SESSION,
      metadata: sessionMetadata(activeServerDir, join(activeServerDir, 'retired-home')), actor: 'owner' });
    expect(result).toMatchObject({ ok: false, errorCode: 'source_export_failed',
      error: expect.stringMatching(/recorded at launch for thread-shared-machine no longer exists/) });
  });
});
