import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { AgentSessionRuntime, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV } from '@happier-dev/plugin-sdk/connected-accounts';
import { activate, PLUGIN_MANIFEST, PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID } from '@happier-dev/plugins-pi';

import { createNativeAgentSessionPublications } from './nativeAgentSessionPublications';

describe('Pi native account model publication', () => {
  it('withholds registry candidates through the real public runtime and host model binding', async () => {
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const directory = await mkdtemp(join(tmpdir(), 'pi-account-catalog-'));
    const signal = new AbortController().signal;
    const publications = createNativeAgentSessionPublications({ agentId: 'pi', session: null, signal,
      isCurrent: () => true, supportsInFlightSteer: false });
    let listener: ((record: unknown) => void | Promise<void>) | undefined;
    let finish!: (result: PluginProcessResult) => void;
    const exited = new Promise<PluginProcessResult>(resolve => { finish = resolve; });
    const dispose = async () => { finish({ termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
      stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false }); };
    const native: PluginProtocolClientHandle<'jsonStream'> = {
      client: { subscribe(next) { listener = next; return { dispose() { listener = undefined; } }; },
        async write(record: JsonValue) {
          if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Expected Pi command');
          await listener?.({ type: 'response', id: record.id, command: record.type, success: true,
            data: record.type === 'get_state' ? { sessionId: 'selected-native', model: { provider: 'openai-codex', id: 'selected' } } : { commands: [] } });
        }, dispose },
      process: { pid: 123, async write() {}, async closeStdin() {}, async waitForExit() { return (await exited).termination; },
        wait: () => exited, onOutput: () => ({ dispose() {} }), dispose },
      wait: () => exited, dispose,
    };
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    // Only the selected Account and OS/native Pi RPC are substituted; publication stays real.
    const context = { signal, session: { id: 'selected-session', services: publications.services }, services: {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      connectedAccounts: {
        async getBinding(purpose: string) { return purpose === PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID
          ? { purpose, service, account: { service, accountId: 'selected-account' }, target: { kind: 'account' as const, displayName: 'Selected' } } : null; },
        async materialize() { throw new Error('Request-scoped auth must not materialize a key'); },
        watch(_purpose: string, next: (event: { kind: 'resync'; authorityChanged: boolean }) => void | Promise<void>) {
          void next({ kind: 'resync', authorityChanged: false }); return { dispose() {} };
        },
      },
      exec: { systemTools: { async resolve() { return { executable: { kind: 'systemTool', id: 'pi-cli' }, executablePath: '/fixture/pi' }; } },
        clients: { async spawn() { return native; } },
        async run() { return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
          stdout: new TextEncoder().encode('0.82.1'), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false }; },
      },
    } } as unknown as AgentSessionRuntimeContext;
    let session: AgentSessionRuntime | undefined;
    try {
      const factory = plugin.registration('agents', 'pi')?.factory;
      if (!factory) throw new Error('Public Pi registration missing');
      const runtime = await factory({ plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, agent: { id: 'pi' }, signal });
      if (!runtime.sessions) throw new Error('Public Pi runtime has no Session surface');
      session = await runtime.sessions.open({ kind: 'create', sessionId: 'selected-session', cwd: directory,
        launchEnvironment: { values: { PI_CODING_AGENT_DIR: directory, [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]: join(directory, 'request-auth.json') }, unset: [] },
        configuration: { model: { value: 'openai-codex/selected', updatedAtMs: 1 }, mode: { value: null, updatedAtMs: 1 },
          permissionIntent: { value: null, updatedAtMs: 1 }, options: {} },
      }, context);
      await listener?.({ type: 'happier-pi-model-catalog', models: [
        { provider: 'openai-codex', id: 'selected', name: 'Selected candidate' },
        { provider: 'openai-codex', id: 'not-entitled', name: 'Other candidate' },
      ] });
      expect(publications.modelsSource.read()).toMatchObject({ currentModelId: 'openai-codex/selected', models: [] });
    } finally {
      await session?.dispose(); publications.dispose(); await plugin.dispose(); await rm(directory, { recursive: true, force: true });
    }
  });
});
