import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
    vi.unstubAllEnvs();
  });

  it('delivers base and tool guidance through the bridge flags, not the spawn prompt', async () => {
    const agentDir = createTempDirSync('happier-pi-bridge-runtime-');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    try {
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
        fallbackToolDelivery: 'shell_bridge',
        accountSettings: {},
      });

      await runtime.startOrLoad({});

      // The bridge extension owns the base prompt blocks (session title, response
      // options, attachments, memory recall) and the bridge tool guidance, driven by
      // its launch flags. The spawn-time append prompt must not duplicate any of it:
      // with no prompt stacks or execution-runs guidance configured there is nothing
      // left for the daemon to deliver.
      expect(createCalls[0]?.appendSystemPromptText).toBeUndefined();
      expect(createCalls[0]?.happyToolsBridge).toBeDefined();
      expect(createCalls[0]?.happyToolsBridge?.sessionConfig.directTools.map((tool) => tool.name)).toContain('change_title');
      expect(createCalls[0]?.happyToolsBridge?.sessionConfig.promptAddition).toContain('<options>');
      expect(createCalls[0]?.happyToolsBridge?.sessionConfig.directTools.map((tool) => tool.name)).not.toContain('memory_search');
    } finally {
      removeTempDirSync(agentDir);
    }
  });

  it('preserves canonical base-before-supplemental ordering inside the bridge prompt', async () => {
    const agentDir = createTempDirSync('happier-pi-bridge-runtime-');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    try {
      const createCalls: CatalogAcpRuntimeCreateCall[] = [];
      createCatalogAcpBackendSpy(createCalls);
      const session = Object.assign(createApiSessionClientFixture(), {
        sessionId: 'happy-session-ordered-prompt',
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
        fallbackToolDelivery: 'shell_bridge',
        accountSettings: {
          executionRunsGuidanceEnabled: true,
          executionRunsGuidanceEntries: [{
            id: 'ordered-supplement',
            description: 'SUPPLEMENTAL_PROFILE_GUIDANCE',
            enabled: true,
          }],
        },
      });

      await runtime.startOrLoad({});

      const promptAddition = createCalls[0]?.happyToolsBridge?.sessionConfig.promptAddition ?? '';
      expect(createCalls[0]?.appendSystemPromptText).toBeUndefined();
      expect(promptAddition).toContain('<options>');
      expect(promptAddition).toContain('SUPPLEMENTAL_PROFILE_GUIDANCE');
      expect(promptAddition.indexOf('<options>')).toBeLessThan(
        promptAddition.indexOf('SUPPLEMENTAL_PROFILE_GUIDANCE'),
      );
    } finally {
      removeTempDirSync(agentDir);
    }
  });

  it('binds memory guidance to the machine id through the bridge, not the spawn prompt', async () => {
    const agentDir = createTempDirSync('happier-pi-bridge-runtime-');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    try {
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
        fallbackToolDelivery: 'shell_bridge',
        accountSettings: {},
        memoryRecallGuidanceEnabled: true,
      });

      await runtime.startOrLoad({});

      const appendSystemPromptText = createCalls[0]?.appendSystemPromptText ?? '';
      expect(appendSystemPromptText).not.toContain('memory_search');
      expect(appendSystemPromptText).not.toContain('machine-9');
      expect(createCalls[0]?.happyToolsBridge?.sessionConfig.directTools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['memory_search', 'memory_get_window']),
      );
      expect(createCalls[0]?.happyToolsBridge?.sessionConfig.promptAddition).toContain('memory_search');
    } finally {
      removeTempDirSync(agentDir);
    }
  });

  it('derives the bridge config from the profile override, not raw global settings', async () => {
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
        fallbackToolDelivery: 'shell_bridge',
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

      // The bridge config must come from the merged profile override: the profile
      // disables title updates while still inheriting the global response-options
      // setting, so the config flags carry exactly that merged decision.
      expect(createCalls[0]?.appendSystemPromptText ?? '').not.toContain('change_title');
      expect(createCalls[0]?.happyToolsBridge).toBeDefined();
      expect(createCalls[0]?.happyToolsBridge?.sessionConfig.directTools.map((tool) => tool.name)).not.toContain('change_title');
      expect(createCalls[0]?.happyToolsBridge?.sessionConfig.promptAddition).not.toContain('change_title');
      expect(createCalls[0]?.happyToolsBridge?.sessionConfig.promptAddition).toContain('<options>');
    } finally {
      removeTempDirSync(agentDir);
    }
  });

  it('keeps rename enabled without a profile override (REQ-2)', async () => {
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
        fallbackToolDelivery: 'shell_bridge',
        accountSettings: {
          codingPromptBehaviorV1: {
            v: 1,
            sessionTitleUpdates: 'ongoing',
            responseOptions: 'agent',
          },
        },
      });

      await runtime.startOrLoad({});

      expect(createCalls[0]?.appendSystemPromptText ?? '').not.toContain('change_title');
      expect(createCalls[0]?.happyToolsBridge?.sessionConfig.directTools.map((tool) => tool.name)).toContain('change_title');
      expect(createCalls[0]?.happyToolsBridge?.sessionConfig.promptAddition).toContain('change_title');
      expect(createCalls[0]?.happyToolsBridge?.sessionConfig.promptAddition).toContain('<options>');
    } finally {
      removeTempDirSync(agentDir);
    }
  });

  it('falls back to the full spawn-time prompt (shell-bridge appendix included) when the bridge cannot bind', async () => {
    // Point the bridge materializer at a regular file: every mkdir/write under it
    // throws ENOTDIR, so the runtime's best-effort bridge resolution fails and the
    // spawn must fall back to delivering the complete prompt itself.
    const notADir = createTempDirSync('happier-pi-bridge-notadir-');
    const agentDir = join(notADir, 'agent-file');
    writeFileSync(agentDir, 'not a directory', 'utf8');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    try {
      const createCalls: CatalogAcpRuntimeCreateCall[] = [];
      createCatalogAcpBackendSpy(createCalls);
      const session = Object.assign(createApiSessionClientFixture(), {
        sessionId: 'happy-session-5',
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
        fallbackToolDelivery: 'shell_bridge',
        accountSettings: {},
      });

      await runtime.startOrLoad({});

      // No bridge: the daemon delivers the complete effective prompt itself,
      // including the CLI shell-bridge tool appendix, via --append-system-prompt.
      const appendSystemPromptText = createCalls[0]?.appendSystemPromptText ?? '';
      expect(appendSystemPromptText).toContain('Happier tools are available through the CLI bridge');
      expect(appendSystemPromptText).toContain("'--session-id' 'happy-session-5'");
      expect(appendSystemPromptText).toContain("'--directory' '/tmp/repo'");
      expect(createCalls[0]?.happyToolsBridge).toBeUndefined();
    } finally {
      removeTempDirSync(notADir);
    }
  });

  it('does not advertise the shell bridge when runtime availability resolved to unsupported', async () => {
    const notADir = createTempDirSync('happier-pi-bridge-notadir-');
    const agentDir = join(notADir, 'agent-file');
    writeFileSync(agentDir, 'not a directory', 'utf8');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    try {
      const createCalls: CatalogAcpRuntimeCreateCall[] = [];
      createCatalogAcpBackendSpy(createCalls);
      const session = Object.assign(createApiSessionClientFixture(), {
        sessionId: 'happy-session-unsupported',
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
        fallbackToolDelivery: 'unsupported',
      });

      await runtime.startOrLoad({});

      expect(createCalls[0]?.happyToolsBridge).toBeUndefined();
    } finally {
      removeTempDirSync(notADir);
    }
  });
});
