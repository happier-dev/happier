import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

import type { Credentials } from '@/persistence';
import type { CatalogAcpRuntimeCreateCall } from '@/testkit/backends/catalogAcpRuntime';
import { createCatalogAcpBackendSpy, createMessageBufferFixture, createSessionProviderInputConsumerFixture } from '@/testkit/backends/catalogAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import { createPiAcpRuntime } from './runtime';

const credentials: Credentials = {
  token: 'test-token',
  encryption: { type: 'legacy', secret: new Uint8Array([1]) },
};

describe('Pi ACP runtime spawn system prompt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delivers the shell-bridge tool appendix in the spawn-time system prompt', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    createCatalogAcpBackendSpy(createCalls);
    const session = Object.assign(createApiSessionClientFixture(), {
      sessionId: 'happy-session-1',
    });

    const runtime = createPiAcpRuntime({
      directory: '/tmp/repo',
      machineId: 'machine-1',
      session,
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      getPermissionMode: () => 'default',
      providerInputConsumer: createSessionProviderInputConsumerFixture(),
      credentials,
      accountSettings: {},
    });

    await runtime.startOrLoad({});

    const appendSystemPromptText = createCalls[0]?.appendSystemPromptText ?? '';
    expect(appendSystemPromptText).toContain('Happier tools are available through the CLI bridge');
    expect(appendSystemPromptText).toContain("'--session-id' 'happy-session-1'");
    expect(appendSystemPromptText).toContain("'--directory' '/tmp/repo'");
  });

  it('includes memory recall guidance in the spawn-time system prompt when enabled', async () => {
    const createCalls: CatalogAcpRuntimeCreateCall[] = [];
    createCatalogAcpBackendSpy(createCalls);
    const session = Object.assign(createApiSessionClientFixture(), {
      sessionId: 'happy-session-2',
    });

    const runtime = createPiAcpRuntime({
      directory: '/tmp/repo',
      machineId: 'machine-9',
      session,
      messageBuffer: createMessageBufferFixture(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange() {},
      getPermissionMode: () => 'default',
      providerInputConsumer: createSessionProviderInputConsumerFixture(),
      credentials,
      accountSettings: {},
      memoryRecallGuidanceEnabled: true,
    });

    await runtime.startOrLoad({});

    const appendSystemPromptText = createCalls[0]?.appendSystemPromptText ?? '';
    expect(appendSystemPromptText).toContain('memory_search');
    expect(appendSystemPromptText).toContain('machine-9');
  });

  it('derives the tools-bridge rename flag and the appendix from the profile override, not raw global settings', async () => {
    // Point the bridge asset materializer at a temp dir: the runtime falls back to the
    // real ~/.pi/agent when PI_CODING_AGENT_DIR is unset, and tests must not write there.
    const agentDir = createTempDirSync('happier-pi-bridge-runtime-');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    try {
      const createCalls: CatalogAcpRuntimeCreateCall[] = [];
      createCatalogAcpBackendSpy(createCalls);
      const session = Object.assign(
        createApiSessionClientFixture({
          metadata: createTestMetadata({ profileId: 'profile-no-titles' } as never),
        }),
        { sessionId: 'happy-session-3' },
      );

      const runtime = createPiAcpRuntime({
        directory: '/tmp/repo',
        machineId: 'machine-1',
        session,
        messageBuffer: createMessageBufferFixture(),
        mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange() {},
        getPermissionMode: () => 'default',
        providerInputConsumer: createSessionProviderInputConsumerFixture(),
        credentials,
        accountSettings: {
          codingPromptBehaviorV1: {
            v: 1,
            sessionTitleUpdates: 'ongoing',
            responseOptions: 'agent',
          },
          profiles: [
            {
              id: 'profile-no-titles',
              name: 'Profile (no titles)',
              codingPromptBehaviorV1: {
                v: 1,
                sessionTitleUpdates: 'disabled',
              },
            },
          ],
        },
      });

      await runtime.startOrLoad({});

      // Both halves of the decision must come from the merged profile override: the
      // prompt appendix carries no rename guidance AND the bridge registers no rename
      // tool. Either half alone is the split-brain this test pins.
      expect(createCalls[0]?.appendSystemPromptText ?? '').not.toContain('change_title');
      expect(createCalls[0]?.happyToolsBridge).toBeDefined();
      expect(createCalls[0]?.happyToolsBridge?.disableRename).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      removeTempDirSync(agentDir);
    }
  });

  it('keeps the tools-bridge rename flag enabled without a profile override (REQ-2)', async () => {
    const agentDir = createTempDirSync('happier-pi-bridge-runtime-');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    try {
      const createCalls: CatalogAcpRuntimeCreateCall[] = [];
      createCatalogAcpBackendSpy(createCalls);
      const session = Object.assign(
        createApiSessionClientFixture({
          metadata: createTestMetadata({ profileId: null } as never),
        }),
        { sessionId: 'happy-session-4' },
      );

      const runtime = createPiAcpRuntime({
        directory: '/tmp/repo',
        machineId: 'machine-1',
        session,
        messageBuffer: createMessageBufferFixture(),
        mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange() {},
        getPermissionMode: () => 'default',
        providerInputConsumer: createSessionProviderInputConsumerFixture(),
        credentials,
        accountSettings: {
          codingPromptBehaviorV1: {
            v: 1,
            sessionTitleUpdates: 'ongoing',
            responseOptions: 'agent',
          },
        },
      });

      await runtime.startOrLoad({});

      expect(createCalls[0]?.appendSystemPromptText ?? '').toContain('change_title');
      expect(createCalls[0]?.happyToolsBridge?.disableRename).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      removeTempDirSync(agentDir);
    }
  });
});
