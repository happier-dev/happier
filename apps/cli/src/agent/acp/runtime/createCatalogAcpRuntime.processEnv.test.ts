import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import type { AgentState } from '@/api/types';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/createProviderEnforcedPermissionHandler';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { withTempDir } from '@/testkit/fs/tempDir';

import { createConfiguredAcpRuntime } from '../catalog/configured/createConfiguredAcpRuntime';
import type { CatalogDefinedAcpBackendOptions } from '../catalog/createCatalogDefinedAcpBackend';
import { createCatalogProviderAcpRuntime } from './createCatalogProviderAcpRuntime';

const envScope = createEnvKeyScope(['HAPPIER_SESSION_ID', 'HAPPIER_KIRO_PATH']);
afterEach(() => envScope.restore());

describe('catalog ACP process environment', () => {
  it.each([
    { kind: 'built-in', sessionId: 'happy-current' },
    { kind: 'built-in', sessionId: 'offline-unresolved' },
    { kind: 'configured', sessionId: 'happy-current' },
    { kind: 'configured', sessionId: 'offline-unresolved' },
  ] as const)('binds $kind primary and replay processes to $sessionId', async ({ kind, sessionId }) => {
    await withTempDir('happier-catalog-acp-env-', async (dir) => {
      envScope.patch({ HAPPIER_SESSION_ID: 'ambient-stale-session' });
      const capturePath = join(dir, 'spawn-environments.jsonl');
      const scriptPath = writeAcpTestAgentScript({ dir, fileName: 'catalog-env.cjs', source: `#!/usr/bin/env node
        const { appendFileSync } = require('node:fs');
        const readline = require('node:readline');
        appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
          sessionId: process.env.HAPPIER_SESSION_ID ?? null,
          configuredValue: process.env.CONFIGURED_VALUE,
          runtimeValue: process.env.RUNTIME_VALUE,
        }) + '\\n');
        const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
        let promptId;
        readline.createInterface({ input: process.stdin }).on('line', (line) => {
          const request = JSON.parse(line);
          if (request.id === 'approve-task' && !request.method) {
            send({ jsonrpc: '2.0', method: 'session/update', params: {
              sessionId: 'primary-session', update: { sessionUpdate: 'tool_call_update', toolCallId: 'task-1', status: 'completed', rawOutput: { output: 'SUBTASK_OK', metadata: { sessionId: 'child-session' } } },
            } });
            send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
            return;
          }
          if (request.method === 'initialize') {
            send({ jsonrpc: '2.0', id: request.id, result: {
              protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true },
            } });
          } else if (request.method === 'session/new') {
            send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'primary-session' } });
          } else if (request.method === 'session/prompt') {
            promptId = request.id;
            send({ jsonrpc: '2.0', method: 'session/update', params: {
              sessionId: 'primary-session', update: { sessionUpdate: 'tool_call', toolCallId: 'task-1', title: 'Task', kind: 'other', rawInput: { prompt: 'work' }, status: 'in_progress' },
            } });
            // ACP's permission request supplies the specific tool identity for generic transports.
            send({ jsonrpc: '2.0', id: 'approve-task', method: 'session/request_permission', params: {
              sessionId: 'primary-session', toolCall: { toolCallId: 'task-1', title: 'Task', kind: 'other', rawInput: { prompt: 'work' } },
              options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
            } });
          } else if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, result: {} });
        });
      ` });
      let agentState: AgentState = {};
      const session = createMutableApiSessionClientFixture<Record<string, unknown>>({
        metadata: {},
        overrides: {
          sessionId,
          getAgentStateSnapshot: () => agentState,
          updateAgentState: async (updater) => { agentState = updater(agentState); },
          updateAgentStateRequestSettlement: async (updater) => { agentState = updater(agentState); },
          // Only the server boundary is stubbed; there is no pending input in this session.
          materializeNextPendingMessageSafely: async () => ({ type: 'no_pending' }),
        },
      });
      const permissionHandler = createProviderEnforcedPermissionHandler({ session, logPrefix: '[CatalogEnv]' });
      permissionHandler.setPermissionMode('yolo');
      const providerInputConsumer = createSessionProviderInputConsumer({
        messageQueue: new MessageQueue2<unknown, unknown>(() => 'default'),
        session,
      });
      const providerPath = process.platform === 'win32'
        ? await writeExecutableShim({ dir, fileName: 'kiro.cmd', contents: `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n` })
        : await writeExecutableShim({ dir, fileName: 'kiro.cjs', contents: readFileSync(scriptPath, 'utf8') });
      envScope.patch({ HAPPIER_KIRO_PATH: providerPath });
      const common = {
        loggerLabel: 'CatalogEnv', directory: dir, session,
        messageBuffer: new MessageBuffer(), mcpServers: {}, permissionHandler,
        processEnv: { RUNTIME_VALUE: 'preserved-runtime' },
        onThinkingChange: () => {}, providerInputConsumer,
      };
      const runtime = kind === 'built-in'
        ? createCatalogProviderAcpRuntime<CatalogDefinedAcpBackendOptions>({
          ...common, provider: 'kiro', sessionIdentity: { kind: 'manifest-metadata' },
          backendOptions: { launch: { command: process.execPath, args: [scriptPath] } },
        })
        : createConfiguredAcpRuntime({
          ...common,
          backend: {
            backendId: 'review-bot', name: 'review-bot', title: 'Review Bot',
            command: process.execPath, args: [scriptPath], env: {}, transportProfile: 'generic',
            capabilities: { supportsLoadSession: true, supportsModes: 'unknown', supportsModels: 'unknown', supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' },
          },
          launchEnv: { HAPPIER_SESSION_ID: 'configured-stale-session', CONFIGURED_VALUE: 'preserved' },
        });
      const environments = () => existsSync(capturePath)
        ? readFileSync(capturePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
        : [];
      try {
        await runtime.startOrLoad({});
        expect(environments()[0]).toEqual({
          sessionId: sessionId.startsWith('offline-') ? null : sessionId,
          ...(kind === 'configured' ? { configuredValue: 'preserved' } : {}), runtimeValue: 'preserved-runtime',
        });
        await runtime.sendPrompt('delegate work');
        await expect.poll(() => environments().length).toBe(2);
        expect(environments()).toEqual(Array.from({ length: 2 }, () => ({
          sessionId: sessionId.startsWith('offline-') ? null : sessionId,
          ...(kind === 'configured' ? { configuredValue: 'preserved' } : {}), runtimeValue: 'preserved-runtime',
        })));
      } finally {
        await runtime.reset();
      }
    });
  });
});
