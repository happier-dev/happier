import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClient } from '@/api/api';
import type { AgentState } from '@/api/types';
import * as persistence from '@/persistence';
import * as daemonControl from '@/daemon/controlClient';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createMutableApiSessionClientFixture, createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { PendingQueueMaterializationAuthError } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';

import { runCatalogDefinedAcpAgent } from './runCatalogDefinedAcpAgent';
import { runConfiguredAcpBackend } from './configured/runConfiguredAcpBackend';

const env = createEnvKeyScope(['HAPPIER_KIRO_PATH', 'HAPPIER_SESSION_ID', 'HAPPIER_ACP_ENV_CAPTURE_PATH']);
afterEach(() => {
  vi.restoreAllMocks();
  env.restore();
});

describe('catalog ACP runner process environment', () => {
  it.each(['built-in', 'configured'] as const)('binds the %s agent process to its current Happier session', async (kind) => {
    await withTempDir('happier-catalog-session-env-', async (dir) => {
      const capturePath = join(dir, 'environment.json');
      const scriptPath = writeAcpTestAgentScript({
        dir,
        fileName: 'capture-environment.cjs',
        source: `#!/usr/bin/env node
          const { writeFileSync } = require('node:fs');
          const readline = require('node:readline');
          writeFileSync(process.env.HAPPIER_ACP_ENV_CAPTURE_PATH, JSON.stringify({
            sessionId: process.env.HAPPIER_SESSION_ID,
            configuredValue: process.env.CONFIGURED_VALUE,
          }));
          const lines = readline.createInterface({ input: process.stdin });
          lines.on('line', (line) => {
            const request = JSON.parse(line);
            const result = request.method === 'initialize'
              ? { protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true } }
              : request.method === 'session/prompt' ? { stopReason: 'end_turn' } : {};
            if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
          });
        `,
      });
      const providerPath = process.platform === 'win32'
        ? await writeExecutableShim({
          dir, fileName: 'kiro.cmd',
          contents: `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
        })
        : await writeExecutableShim({ dir, fileName: 'kiro.cjs', contents: readFileSync(scriptPath, 'utf8') });
      env.patch({
        HAPPIER_KIRO_PATH: providerPath,
        HAPPIER_SESSION_ID: 'outer-session',
        HAPPIER_ACP_ENV_CAPTURE_PATH: capturePath,
      });
      let agentState: AgentState = {};
      const session = createMutableApiSessionClientFixture({
        metadata: createTestMetadata({ path: dir, flavor: kind === 'built-in' ? 'kiro' : 'acp:review-bot' }),
        overrides: {
          bindProviderInputOutcomeProducer: () => () => {},
          onUserMessage: (handler) => { handler({ role: 'user', content: { type: 'text', text: 'hello' } }); },
          getAgentStateSnapshot: () => agentState,
          updateAgentState: async (updater) => { agentState = updater(agentState); },
          updateAgentStateRequestSettlement: async (updater) => { agentState = updater(agentState); },
          // This network boundary ends the real prompt loop after explicit resume opened the process.
          materializeNextPendingMessageSafely: async () => ({ type: 'auth_failure', statusCode: 401 }),
          flush: async () => {},
          close: async () => {},
          sendSessionEvent: () => {},
        },
      });
      // Server/API and local persisted settings are external boundaries. Runner, catalog,
      // permission policy, runtime, ACP transport and subprocess launch all remain real.
      const api = {
        getOrCreateSession: async () => createPlainSessionFixture(),
        sessionSyncClient: () => session,
        push: () => ({ sendToAllDevices: async () => {} }),
      };
      vi.spyOn(ApiClient, 'create').mockResolvedValue(api as unknown as ApiClient);
      vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 2, onboardingCompleted: true, machineId: 'machine-test' });
      vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({ pid: process.pid } as Awaited<ReturnType<typeof persistence.readDaemonState>>);
      vi.spyOn(daemonControl, 'notifyDaemonSessionStarted').mockResolvedValue({});
      const credentials = { token: 'test-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
      const options = { credentials, resume: 'vendor-session' };
      const run = kind === 'built-in'
        ? runCatalogDefinedAcpAgent('kiro', options)
        : runConfiguredAcpBackend({
          ...options,
          configuredAcpBackendId: 'review-bot',
          accountSettingsContext: {
            settings: {
              acpCatalogSettingsV1: {
                v: 2,
                backends: [{
                  id: 'review-bot', name: 'review-bot', title: 'Review Bot',
                  command: process.execPath, args: [scriptPath],
                  env: {
                    HAPPIER_SESSION_ID: { t: 'literal', v: 'configured-stale-session' },
                    CONFIGURED_VALUE: { t: 'literal', v: 'preserved' },
                  },
                  transportProfile: 'generic',
                  capabilities: { supportsLoadSession: true },
                  createdAt: 1, updatedAt: 1,
                }],
              },
            },
            settingsSecretsReadKeys: [],
          } as unknown as NonNullable<Parameters<typeof runConfiguredAcpBackend>[0]['accountSettingsContext']>,
        });
      await expect(run).rejects.toBeInstanceOf(PendingQueueMaterializationAuthError);
      expect(JSON.parse(readFileSync(capturePath, 'utf8'))).toEqual({
        sessionId: session.sessionId,
        ...(kind === 'configured' ? { configuredValue: 'preserved' } : {}),
      });
    });
  });
});
