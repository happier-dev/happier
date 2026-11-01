import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import type { Metadata } from '@/api/types';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture, createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createSessionProviderInputConsumerFixture } from '@/testkit/backends/catalogAcpRuntime';
import { withTempDir } from '@/testkit/fs/tempDir';

import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import { createCursorAcpRuntime } from './runtime';

function writeCursorConfigStubAgent(params: { dir: string; callsPath: string; emptyOnUpdate?: boolean; proprietary?: boolean }): string {
  const source = `#!/usr/bin/env node
    import { writeFileSync } from 'node:fs';

    const decoder = new TextDecoder();
    let buf = '';
    const callsPath = ${JSON.stringify(params.callsPath)};
    let configOptions = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'default[]',
        options: [
          {
            group: 'cursor',
            name: 'Cursor',
            options: [
              { value: 'default[]', name: 'Default' },
              { value: 'gpt-5.1-codex-max[reasoning=medium,fast=false]', name: 'GPT-5.1 Codex Max' },
            ],
          },
        ],
      },
      {
        id: 'fast',
        name: 'Fast Mode',
        type: 'select',
        currentValue: 'false',
        options: [
          { value: 'false', name: 'False' },
          { value: 'true', name: 'True' },
        ],
      },
    ];
    const calls = [];

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    function record(params) {
      calls.push(params);
      writeFileSync(callsPath, JSON.stringify({ calls }, null, 2), 'utf8');
    }

    process.stdin.on('data', (chunk) => {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let req;
        try { req = JSON.parse(trimmed); } catch { continue; }
        const { id, method, params } = req || {};
        if (id === undefined || id === null || typeof method !== 'string') continue;

        if (method === 'initialize') {
          ok(id, { protocolVersion: 1, authMethods: [{ id: 'cursor_login', name: 'Cursor Login' }] });
          continue;
        }
        if (method === 'authenticate') {
          ok(id, {});
          continue;
        }
        if (method === 'session/new') {
          ok(id, { sessionId: 'cursor-config-stub-session', configOptions });
          continue;
        }
        if (method === 'cursor/list_available_models') {
          ok(id, { models: ${params.proprietary ? "[{ value: 'proprietary', name: 'Proprietary' }]" : '[]'} });
          continue;
        }
        if (method === 'session/set_config_option') {
          record(params);
          configOptions = configOptions.map((option) =>
            option.id === params.configId ? { ...option, currentValue: params.value } : option
          );
          if (${params.emptyOnUpdate === true} && params.value === 'true') {
            configOptions = configOptions.map((option) => option.id === 'model' ? { ...option, options: [] } : option);
          }
          ok(id, { configOptions });
          continue;
        }

        ok(id, {});
      }
    });
  `;

  const script = writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'cursor-config-stub.mjs',
    source,
  });
  chmodSync(script, 0o755);
  return script;
}

describe('createCursorAcpRuntime', () => {
  it.each([false, true])('publishes only the merged catalog when standard choices become empty (proprietary %s)', async (proprietary) => {
    await withTempDir('happier-cursor-runtime-empty-', async (dir) => {
      const cursorPath = writeCursorConfigStubAgent({ dir, callsPath: join(dir, 'calls.json'), emptyOnUpdate: true, proprietary });
      const session = createMutableApiSessionClientFixture({ metadata: createTestMetadata() });
      const runtime = createCursorAcpRuntime({
        directory: dir, machineId: 'machine-1', session, messageBuffer: new MessageBuffer(),
        mcpServers: {}, permissionHandler: createApprovedPermissionHandler(), onThinkingChange: () => {},
        env: { HAPPIER_CURSOR_PATH: cursorPath },
        providerInputConsumer: createSessionProviderInputConsumerFixture(),
      });
      try {
        await runtime.startOrLoad({ resumeId: null });
        const publishedModels: string[][] = [];
        const updateMetadata = session.updateMetadata.bind(session);
        session.updateMetadata = async (updater) => updateMetadata((metadata: Metadata | null) => {
          if (!metadata) return metadata;
          const next = updater(metadata);
          if (next?.sessionModelsV1 !== metadata?.sessionModelsV1) {
            publishedModels.push(next?.sessionModelsV1?.availableModels.map((model) => model.id) ?? []);
          }
          return next;
        });
        if (proprietary) {
          await runtime.setSessionConfigOption('fast', 'false');
          expect(publishedModels.every((models) => models.includes('proprietary'))).toBe(true);
          publishedModels.length = 0;
        }
        await runtime.setSessionConfigOption('fast', 'true');
        const expected = proprietary ? ['proprietary'] : [];
        expect(publishedModels.length).toBeGreaterThan(0);
        expect(publishedModels.every((models) => JSON.stringify(models) === JSON.stringify(expected))).toBe(true);
        expect(session.getMetadataSnapshot()?.sessionModelsV1?.availableModels.map((model) => model.id)).toEqual(expected);
      } finally { await runtime.reset(); }
    });
  });

  it.each([
    { modelId: 'gpt-5.1-codex-max-medium-fast', fast: 'true' },
    { modelId: 'gpt-5.1-codex-max[fast=false]', fast: 'false' },
  ])('applies startup model $modelId through Cursor ACP config options', async ({ modelId, fast }) => {
    await withTempDir('happier-cursor-runtime-config-', async (dir) => {
      const callsPath = join(dir, 'config-calls.json');
      const cursorPath = writeCursorConfigStubAgent({ dir, callsPath });
      const runtime = createCursorAcpRuntime({
        directory: dir,
        machineId: 'machine-1',
        session: createApiSessionClientFixture(),
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange: () => {},
        env: {
          HAPPIER_CURSOR_PATH: cursorPath,
        },
        startupOverrides: {
          model: {
            modelId,
            updatedAt: 123,
          },
        },
        providerInputConsumer: createSessionProviderInputConsumerFixture(),
      });

      try {
        await runtime.startOrLoad({ resumeId: null });
        const recorded = JSON.parse(readFileSync(callsPath, 'utf8')) as { calls: unknown[] };

        expect(recorded.calls).toEqual([
          {
            sessionId: 'cursor-config-stub-session',
            configId: 'model',
            value: 'gpt-5.1-codex-max[reasoning=medium,fast=false]',
          },
          {
            sessionId: 'cursor-config-stub-session',
            configId: 'fast',
            value: fast,
          },
        ]);
      } finally {
        await runtime.reset();
      }
    });
  });
});
