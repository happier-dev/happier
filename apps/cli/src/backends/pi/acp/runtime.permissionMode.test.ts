import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Metadata, PermissionMode } from '@/api/types';
import type { CatalogAcpRuntimeCreateCall, CatalogAcpSessionOpenCall } from '@/testkit/backends/catalogAcpRuntime';
import type { Credentials } from '@/persistence';
import { createCatalogAcpBackendSpy, createMessageBufferFixture, createSessionProviderInputConsumerFixture } from '@/testkit/backends/catalogAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture, createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { formatPiSessionDirectoryForCwd } from '@/backends/pi/utils/piSessionFiles';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import { createPiAcpRuntime } from './runtime';

const credentials: Credentials = {
  token: 'test-token',
  encryption: { type: 'legacy', secret: new Uint8Array([1]) },
};

describe('Pi ACP runtime permission mode wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes the Happier session id to createCatalogAcpBackend', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    const createSpy = createCatalogAcpBackendSpy(createCalls);
    const session = Object.assign(createApiSessionClientFixture(), {
      sessionId: 'happy-session-1',
    });

    const runtime = createPiAcpRuntime({
      directory: '/tmp',
      machineId: 'machine-1',
      credentials,
      session,
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      getPermissionMode: () => 'default',
      providerInputConsumer: createSessionProviderInputConsumerFixture(),
    });

    await runtime.startOrLoad({});

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createCalls[0]).toMatchObject({
      agentId: 'pi',
      happierSessionId: 'happy-session-1',
    });
  });

  it('passes the process env to the Pi backend factory for connected-service launch decisions', async () => {
    const previousSelections = process.env.HAPPIER_PI_BROKER_SELECTIONS;
    process.env.HAPPIER_PI_BROKER_SELECTIONS = '{"openai":{"serviceId":"openai-codex","profileId":"codex-work","accountId":"acct_1","planType":"pro"}}';

    try {
      const createCalls: CatalogAcpRuntimeCreateCall[] = [];
      createCatalogAcpBackendSpy(createCalls);

      const runtime = createPiAcpRuntime({
        directory: '/tmp',
        machineId: 'machine-1',
        credentials,
        session: createApiSessionClientFixture(),
        messageBuffer: createMessageBufferFixture(),
        mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange() {},
        getPermissionMode: () => 'default',
        providerInputConsumer: createSessionProviderInputConsumerFixture(),
      });

      await runtime.startOrLoad({});

      expect(createCalls[0].env?.HAPPIER_PI_BROKER_SELECTIONS).toBe(process.env.HAPPIER_PI_BROKER_SELECTIONS);
    } finally {
      if (previousSelections === undefined) {
        delete process.env.HAPPIER_PI_BROKER_SELECTIONS;
      } else {
        process.env.HAPPIER_PI_BROKER_SELECTIONS = previousSelections;
      }
    }
  });

  it('binds Pi session open to the enclosing runner cancellation signal', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    const sessionOpenCalls: CatalogAcpSessionOpenCall[] = [];
    createCatalogAcpBackendSpy(createCalls, sessionOpenCalls);
    const controller = new AbortController();

    const runtime = createPiAcpRuntime({
      directory: '/tmp',
      credentials,
      machineId: 'machine-1',
      session: createApiSessionClientFixture(),
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      getSessionOpenAbortSignal: () => controller.signal,
      providerInputConsumer: createSessionProviderInputConsumerFixture(),
    });

    await runtime.startOrLoad({});

    expect(sessionOpenCalls).toEqual([{
      initialPrompt: undefined,
      options: { signal: controller.signal },
    }]);
  });

  it('forwards permissionMode to createCatalogAcpBackend and recreates backend after reset', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    const createSpy = createCatalogAcpBackendSpy(createCalls);

    let permissionMode: PermissionMode = 'default';

    const runtime = createPiAcpRuntime({
      directory: '/tmp',
      machineId: 'machine-1',
      credentials,
      session: createApiSessionClientFixture(),
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      getPermissionMode: () => permissionMode,
      providerInputConsumer: createSessionProviderInputConsumerFixture(),
    });

    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createCalls.map(({ agentId, permissionMode }) => ({ agentId, permissionMode }))).toEqual([
      { agentId: 'pi', permissionMode: 'default' },
    ]);

    permissionMode = 'read-only';
    await runtime.reset();
    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createCalls[1]).toMatchObject({ agentId: 'pi', permissionMode: 'read-only' });
  });

  it('publishes piSessionFile metadata when the PI session file is discoverable from runtime env', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'pi-acp-runtime-'));
    const cwd = join(tempRoot, 'repo');
    const encodedCwdDir = formatPiSessionDirectoryForCwd(cwd);
    const agentDir = join(tempRoot, 'pi-agent-dir');
    const sessionsDir = join(agentDir, 'sessions', encodedCwdDir);
    await mkdir(sessionsDir, { recursive: true });
    const sessionFile = join(sessionsDir, 'session-1.jsonl');
    await writeFile(sessionFile, '{}\n');

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const createCalls: CatalogAcpRuntimeCreateCall[] = [];
      createCatalogAcpBackendSpy(createCalls);
      const session = createMutableApiSessionClientFixture<Metadata>({
        metadata: createTestMetadata({ flavor: 'pi' }),
      });

      const runtime = createPiAcpRuntime({
        directory: cwd,
        machineId: 'machine-1',
        credentials,
        session,
        messageBuffer: createMessageBufferFixture(),
        mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange() {},
        getPermissionMode: () => 'default',
        providerInputConsumer: createSessionProviderInputConsumerFixture(),
      });

      await runtime.startOrLoad({});

      await vi.waitFor(() => {
        const metadata = session.__getMetadata();
        expect((metadata as Metadata & { piSessionFile?: string }).piSessionFile).toBe(sessionFile);
        expect(metadata?.agentRuntimeDescriptorV1).toEqual({
          v: 1,
          providerId: 'pi',
          provider: {
            resumeStrategy: 'sessionFileAbsolutePreferred',
            vendorSessionId: 'session-1',
            sessionFile,
          },
        });
      });
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });
});
