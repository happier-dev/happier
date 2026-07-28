import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Metadata, PermissionMode } from '@/api/types';
import type { CatalogAcpRuntimeCreateCall } from '@/testkit/backends/catalogAcpRuntime';
import { createCatalogAcpBackendSpy, createMessageBufferFixture } from '@/testkit/backends/catalogAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture, createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { formatPiSessionDirectoryForCwd } from '@/backends/pi/utils/piSessionFiles';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import * as acpModule from '@/agent/acp';

import { createPiAcpRuntime } from './runtime';

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
      session,
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      getPermissionMode: () => 'default',
    });

    await runtime.startOrLoad({});

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createCalls[0]).toMatchObject({
      agentId: 'pi',
      happierSessionId: 'happy-session-1',
    });
  });

  it('forwards permissionMode to createCatalogAcpBackend and recreates backend after reset', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    const createSpy = createCatalogAcpBackendSpy(createCalls);

    let permissionMode: PermissionMode = 'default';

    const runtime = createPiAcpRuntime({
      directory: '/tmp',
      machineId: 'machine-1',
      session: createApiSessionClientFixture(),
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      getPermissionMode: () => permissionMode,
    });

    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createCalls).toEqual([{ agentId: 'pi', permissionMode: 'default' }]);

    permissionMode = 'read-only';
    await runtime.reset();
    await runtime.startOrLoad({});
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createCalls[1]).toEqual({ agentId: 'pi', permissionMode: 'read-only' });
  });

  it('resumes an absolute Pi session-file reference while binding the returned bare vendor id', async () => {
    const resumeReference = '/tmp/pi/sessions/2026-07-12T00-00-00_pi-session-1.jsonl';
    const loadSession = vi.fn(async () => ({ sessionId: 'pi-session-1' }));
    vi.spyOn(acpModule, 'createCatalogAcpBackend').mockResolvedValue({
      backend: {
        startSession: async () => ({ sessionId: 'unused' }),
        loadSession,
        sendPrompt: async () => {},
        cancel: async () => {},
        onMessage: () => {},
        dispose: async () => {},
      },
    } as unknown as Awaited<ReturnType<typeof acpModule.createCatalogAcpBackend>>);

    const runtime = createPiAcpRuntime({
      directory: '/tmp',
      machineId: 'machine-1',
      session: createApiSessionClientFixture(),
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      getPermissionMode: () => 'default',
    });

    await expect(runtime.startOrLoad({ resumeId: resumeReference })).resolves.toBe('pi-session-1');
    expect(loadSession).toHaveBeenCalledWith(resumeReference);
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
        session,
        messageBuffer: createMessageBufferFixture(),
        mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange() {},
        getPermissionMode: () => 'default',
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
