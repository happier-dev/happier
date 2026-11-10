import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentSessionConfigurationSnapshot, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ConnectedAccountBindingEvent } from '@happier-dev/plugin-sdk/connected-accounts';
import { activate, PLUGIN_MANIFEST } from '../../../index.js';
import { prepareOhMyPiQualifiedAccounts } from './preparation.js';

const roots: string[] = [];
function privateHome() { const root = mkdtempSync(join(tmpdir(), 'n-omp-test-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function configuration(value: string | null): AgentSessionConfigurationSnapshot {
  return { model: { value, updatedAtMs: 1 }, mode: { value: null, updatedAtMs: 1 },
    permissionIntent: { value: null, updatedAtMs: 1 }, options: {} };
}

function accountBoundary(bound = true) {
  const listeners = new Set<(event: ConnectedAccountBindingEvent) => void | Promise<void>>();
  const service = { pluginId: 'happier.voice.openai', localId: 'openai' };
  const materialize = vi.fn(async () => ({ kind: 'environment' as const, env: { OPENAI_API_KEY: 'fake-selected-key' } }));
  return { listeners, materialize, context: {
    signal: new AbortController().signal,
    services: { connectedAccounts: {
      async getBinding(purpose: string) { return bound && purpose === 'openai'
        ? { purpose, service, account: { service, accountId: 'selected' }, target: { kind: 'account' as const, displayName: 'Selected' } } : null; },
      materialize,
      watch(_purpose: string, listener: (event: ConnectedAccountBindingEvent) => void | Promise<void>) {
        listeners.add(listener);
        queueMicrotask(() => void listener({ kind: 'resync', authorityChanged: false }));
        return { dispose() { listeners.delete(listener); } };
      },
    } },
  } };
}

describe('Oh My Pi selected account model preparation', () => {
  it.each([undefined, null, 'default', '   '])('refuses fresh native Session and finite launches without a model (%s) before credential delivery', async model => {
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const factory = plugin.registration('agents', 'ohmypi')?.factory;
      if (!factory) throw new Error('Public Agent registration missing');
      const runtime = await factory({ plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
        agent: { id: 'ohmypi' }, signal: new AbortController().signal });
      for (const finite of [false, true]) {
        const boundary = accountBoundary();
        const native = { async send() { return { status: 'admitted' as const }; }, async stop() { return { status: 'requested' as const }; },
          watch: () => ({ dispose() {} }), async dispose() {} };
        const open = vi.fn(async (_request: { launchEnvironment?: { values: Readonly<Record<string, string>> } }) => native);
        // Connected Accounts and native ACP are public host/process boundaries.
        const context = { ...boundary.context, protocols: { acp: { open, openExecutionRunV1: open } } };
        const common = { cwd: '/workspace', ...(model === undefined ? {} : { configuration: configuration(model) }) };
        const pending = finite
          ? runtime.sessions.executionRunContextV1!.open({ ...common, kind: 'create', runId: 'selected-run',
              profile: { pluginId: PLUGIN_MANIFEST.id, localId: 'default' }, input: { text: 'Work.' } }, context as unknown as AgentExecutionRunRuntimeContextV1)
          : runtime.sessions.open({ ...common, kind: 'create', sessionId: 'selected-session' }, context as unknown as AgentSessionRuntimeContext);
        try {
          await expect(pending).rejects.toMatchObject({ code: 'agent_startup_model_reconciliation_failed', retryable: false,
            details: { failureCause: { code: 'agent_startup_model_reconciliation_failed', phase: 'client_start',
              failureReason: 'model_selection_required', retryable: false } } });
          expect(boundary.materialize).not.toHaveBeenCalled();
          expect(open).not.toHaveBeenCalled();
          expect(boundary.listeners.size).toBe(0);
        } finally { await (await pending.catch(() => null))?.dispose(); }
      }
    } finally { await plugin.dispose(); }
  });

  it('preserves explicit native selection, resume, admitted Provider selection and preflight listing', async () => {
    for (const request of [
      { kind: 'create' as const, configuration: configuration('openai/selected') },
      { kind: 'resume' as const },
      { kind: 'create' as const, providerBinding: { connectionId: 'gateway', model: { id: 'selected', name: 'Selected' },
        upstream: { protocol: 'openai-responses', normalizedUrl: 'https://gateway.example/v1', credential: 'none' as const },
        materialization: { v: 1 as const, kind: 'spawnEnv' as const } } },
      {},
    ]) {
      const boundary = accountBoundary();
      const prepared = await prepareOhMyPiQualifiedAccounts({ ...request, launchEnvironment: { values: { PI_CODING_AGENT_DIR: privateHome() }, unset: [] } }, boundary.context);
      try {
        expect(prepared.request.launchEnvironment.values).toMatchObject({ OPENAI_API_KEY: 'fake-selected-key' });
        expect(boundary.materialize).toHaveBeenCalledOnce();
      } finally { prepared.cleanup(); }
      expect(boundary.listeners.size).toBe(0);
    }
    const native = accountBoundary(false);
    const prepared = await prepareOhMyPiQualifiedAccounts({ kind: 'create', launchEnvironment: { values: { PI_CODING_AGENT_DIR: privateHome() }, unset: [] } }, native.context);
    prepared.cleanup();
    expect(native.materialize).not.toHaveBeenCalled();
  });
});
