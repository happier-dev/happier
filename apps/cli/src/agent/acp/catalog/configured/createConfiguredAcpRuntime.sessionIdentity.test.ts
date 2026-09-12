import { describe, expect, it } from 'vitest';

import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createMessageBufferFixture, createSessionProviderInputConsumerFixture } from '@/testkit/backends/catalogAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { withTempDir } from '@/testkit/fs/tempDir';

import { createConfiguredAcpRuntime } from './createConfiguredAcpRuntime';
import type { ResolvedConfiguredAcpBackend } from './resolveConfiguredAcpBackendFromAccountSettings';

function configuredBackend(command: string, supportsLoadSession: boolean): ResolvedConfiguredAcpBackend {
  return {
    backendId: 'review-bot',
    name: 'review-bot',
    title: 'Review Bot',
    command,
    args: [],
    env: {},
    transportProfile: 'generic',
    capabilities: {
      supportsLoadSession,
      supportsModes: 'unknown',
      supportsModels: 'unknown',
      supportsConfigOptions: 'unknown',
      promptImageSupport: 'unknown',
    },
  };
}

function writeAgent(dir: string, negotiatedLoadSession: boolean): string {
  return writeAcpTestAgentScript({
    dir,
    fileName: 'configured-acp-session-identity.mjs',
    source: `
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
      rl.on('line', (line) => {
        const request = JSON.parse(line);
        if (request.method === 'initialize') {
          send({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              protocolVersion: 1,
              authMethods: [],
              agentCapabilities: { loadSession: ${negotiatedLoadSession} },
            },
          });
          return;
        }
        if (request.method === 'session/new') {
          send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'configured-session-1' } });
          return;
        }
        send({ jsonrpc: '2.0', id: request.id, result: {} });
      });
    `,
  });
}

describe('createConfiguredAcpRuntime session identity', () => {
  it.each([
    { negotiatedLoadSession: false, expectedPersistedSessionId: undefined },
    { negotiatedLoadSession: true, expectedPersistedSessionId: 'configured-session-1' },
  ])(
    'persists a durable configured session id only when load is negotiated ($negotiatedLoadSession)',
    async ({ negotiatedLoadSession, expectedPersistedSessionId }) => {
      await withTempDir('happier-configured-acp-identity-', async (dir) => {
        const scriptPath = writeAgent(dir, negotiatedLoadSession);
        const session = createMutableApiSessionClientFixture<Record<string, unknown>>({ metadata: {} });
        const runtime = createConfiguredAcpRuntime({
          backend: {
            ...configuredBackend(process.execPath, true),
            args: [scriptPath],
          },
          loggerLabel: 'ConfiguredAcpTest',
          directory: dir,
          session,
          messageBuffer: createMessageBufferFixture(),
          mcpServers: {},
          permissionHandler: createApprovedPermissionHandler(),
          launchEnv: {},
          onThinkingChange: () => {},
          providerInputConsumer: createSessionProviderInputConsumerFixture(),
        });

        try {
          await expect(runtime.startOrLoad({})).resolves.toBe('configured-session-1');
          expect(session.__getMetadata()?.customAcpSessionId).toBe(expectedPersistedSessionId);
        } finally {
          await runtime.reset();
        }
      });
    },
    20_000,
  );
});
