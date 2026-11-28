import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import type { ExecutionRunBackendFactoryOptions } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { materializeConnectedServicesForSpawn } from '@/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn';
import {
  createExecutionRunConnectedServicesBridge,
  type ResolveConnectedServiceAuthForRun,
} from '@/daemon/connectedServices/runsBridge/materializeConnectedServicesForRun';

import type { AgentBackend, SessionId } from '@/agent/core/AgentBackend';

const getExecutionRunBackendDescriptorMock = vi.fn();

vi.mock('@/agent/executionRuns/registry/executionRunBackendRegistry', () => ({
  getExecutionRunBackendDescriptor: getExecutionRunBackendDescriptorMock,
}));

function createStubBackend(): AgentBackend {
  return {
    async startSession() {
      return { sessionId: 'run-session-1' as SessionId };
    },
    async sendPrompt() {},
    async cancel() {},
    onMessage() {},
    async dispose() {},
    async waitForResponseComplete() {},
  };
}

/**
 * ER-CS LEG-5 integration slice: a codex-target execution run with a PROFILE selection ends up with
 * `CODEX_HOME` pointing at the stable account home containing that profile's auth store with an
 * RFC 3339 `last_refresh` (the canonical writer contract), threaded through the REAL daemon
 * materializer → runs bridge (registration included) → createExecutionRunBackend isolation merge.
 */
describe('execution run connected services (integration: codex profile -> run CODEX_HOME)', () => {
  it('materializes a run root for the selected profile and merges it into the run backend isolation', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-er-cs-base-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-er-cs-server-'));
    const sourceCodexHome = await mkdtemp(join(tmpdir(), 'happier-er-cs-source-codex-'));
    await writeFile(join(sourceCodexHome, 'config.toml'), 'model = "gpt-5.2-codex"\n');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"auth_mode":"apikey","OPENAI_API_KEY":"fixture-source-key"}\n');

    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'access-work',
        refreshToken: 'refresh-work',
        idToken: 'id-work',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-work',
        providerEmail: null,
      },
    });

    // The daemon-side resolver: the REAL materializer owner (what resolveConnectedServiceAuthForSpawn
    // calls once bindings/credentials are resolved), bound to a run-scoped materialization key.
    const resolveAuthForSpawn: ResolveConnectedServiceAuthForRun = (async (params: {
      materializationKey: string;
      sessionDirectory?: string | null;
    }) => {
      const materialized = await materializeConnectedServicesForSpawn({
        agentId: 'codex',
        materializationKey: params.materializationKey,
        activeServerDir,
        baseDir,
        sessionDirectory: params.sessionDirectory ?? null,
        recordsByServiceId: new Map([['openai-codex', record]]),
        selectionsByServiceId: new Map([
          ['openai-codex', { kind: 'profile' as const, serviceId: 'openai-codex' as const, profileId: 'work', record }],
        ]),
        processEnv: { CODEX_HOME: sourceCodexHome, HOME: tmpdir() },
      });
      if (!materialized) return null;
      return {
        env: materialized.env,
        cleanupOnFailure: materialized.cleanupOnFailure ?? null,
        cleanupOnExit: materialized.cleanupOnExit ?? null,
        connectedServicesBindings: {
          v: 1 as const,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
          },
        },
        runtimeAccountIdentitySelections: [],
      };
    }) as unknown as ResolveConnectedServiceAuthForRun;

    const registry = new ConnectedServiceRuntimeRegistry();
    const bridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn,
      runtimeRegistry: registry,
    });

    const materializationKey = 'execution_run:integration-1';
    const { env } = await bridge.materialize({
      runId: 'run_integration_1',
      agentId: 'codex',
      pid: 91234,
      materializationKey,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      sessionDirectory: '/tmp/workspace',
    });

    // Runs use the same account home as sessions, never the user's native login.
    expect(env.CODEX_HOME).toBeDefined();
    expect(env.CODEX_HOME).toBe(join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex', 'work', 'codex', 'codex-home'));
    expect(env.CODEX_HOME).not.toBe(sourceCodexHome);

    // The account's auth store retains the pinned RFC 3339 last_refresh contract.
    const auth = JSON.parse(await readFile(join(env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('access-work');
    expect(auth.account_id).toBe('acct-work');
    expect(typeof auth.last_refresh).toBe('string');
    expect(Number.isNaN(Date.parse(auth.last_refresh))).toBe(false);
    // RFC 3339 shape (not epoch millis — the triage-#4 poison class).
    expect(auth.last_refresh).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u);

    // The run is registered in the runtime-registry RUN KEYSPACE under the run-scoped key, carrying
    // its runner pid, and is covered by refresh redistribution (R3-1 — coexists with any session
    // target on the same pid instead of being skipped).
    const runRefreshTarget = registry.listRefreshTargets().find((target) => target.materializationKey === materializationKey);
    expect(runRefreshTarget).toBeDefined();
    expect(runRefreshTarget?.pid).toBe(91234);

    // The env merges into the run backend isolation bundle at the pinned choke point.
    const captured: { options?: ExecutionRunBackendFactoryOptions } = {};
    getExecutionRunBackendDescriptorMock.mockReturnValue({
      factory: (opts: ExecutionRunBackendFactoryOptions) => {
        captured.options = opts;
        return createStubBackend();
      },
    });
    const { createExecutionRunBackend } = await import('./createExecutionRunBackend');
    createExecutionRunBackend({
      cwd: '/tmp/workspace',
      runId: 'run_integration_1',
      backendId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      connectedServicesEnv: env,
    });
    expect(captured.options?.isolation?.env?.CODEX_HOME).toBe(env.CODEX_HOME);
  });
});
