import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { buildPiModelDiscoveryExtensionSource } from '../models/discoveryExtension.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentPreflightSessionControlsContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import { PI_PREFLIGHT_SESSION_CONTROLS } from './models.js';
import { PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID } from '../auth/services/requestAuth/purposes.js';
import { PI_REQUEST_AUTH_CAPABILITY_PATH_ENV, resolvePiRequestAuthExtensionPath } from '../auth/services/requestAuth/index.js';

const observation = (models: unknown[]) => JSON.stringify({ type: 'happier-pi-model-catalog', models });

describe('Pi structured preflight model discovery', () => {
  it.each(['refresh-result', 'list-call', 'registry-error', 'refresh-unsupported', 'offline'] as const)(
    'retains the native failure through preflight refresh diagnostics (%s)', async failureAt => {
      const nativeFailure = Object.assign(new Error('Copilot catalog rejected; Authorization: Bearer private-catalog-token'),
        { phase: 'authentication', code: 'native_catalog_denied' });
      const registry = {
        getAll: () => [{ provider: 'example' }],
        hasConfiguredAuth: () => true,
        refresh: async () => failureAt === 'refresh-unsupported' ? undefined : ({ aborted: false, errors: failureAt === 'refresh-result'
          ? new Map([['example', nativeFailure]]) : new Map() }),
        getError: () => failureAt === 'registry-error' ? nativeFailure.message : undefined,
        getAvailable: () => { if (failureAt === 'list-call') throw nativeFailure; return []; },
      };
      const lines: string[] = [];
      let start: ((_event: unknown, context: { modelRegistry: typeof registry }) => Promise<void>) | undefined;
      // Pi's extension host and registry are the external process boundary.
      const install = runInNewContext(
        buildPiModelDiscoveryExtensionSource({ bypassCache: true }).replace('export default ', '') + '; happierModelDiscovery',
        { Map, Set, process: { env: failureAt === 'offline' ? { PI_OFFLINE: '1' } : {}, stderr: { write: (line: string) => { lines.push(line); } } } },
      );
      install({ on(_event: string, handler: NonNullable<typeof start>) { start = handler; } });
      await start!(undefined, { modelRegistry: registry });
      const result = PI_PREFLIGHT_SESSION_CONTROLS.models.parseOutput?.({
        ok: true, exitCode: 0, stdout: '', stderr: lines.join(''),
      });
      expect(result).toMatchObject({ availableModels: [], source: failureAt === 'refresh-unsupported' ? 'static' : 'unavailable', refreshError: true,
        refreshErrorMessage: expect.stringContaining(failureAt === 'refresh-unsupported'
          ? 'refresh-unsupported' : failureAt === 'offline' ? 'offline' : 'Copilot catalog rejected') });
      if (failureAt === 'refresh-result' || failureAt === 'list-call') {
        expect(JSON.stringify(result)).toContain('authentication');
        expect(JSON.stringify(result)).toContain('native_catalog_denied');
      }
      expect(JSON.stringify(result)).not.toContain('private-catalog-token');
    },
  );

  it('leaves managed Muse source credentials to its Provider catalog owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-preflight-managed-'));
    const service = { pluginId: 'happier.agent.muse', localId: 'muse-account' };
    const controls: AgentPreflightSessionControlsContributionV1 = PI_PREFLIGHT_SESSION_CONTROLS;
    try {
      const prepared = await controls.prepareLaunchEnvironment!({ environment: { PI_CODING_AGENT_DIR: directory },
        connectedAccounts: {
          watch(_purpose, listener) { void listener({ kind: 'resync', authorityChanged: false }); return { dispose() {} }; },
          async getBinding(purpose) { return purpose === 'meta-inference'
            ? { purpose, service, account: { service, accountId: 'selected' }, target: { kind: 'account', displayName: 'Muse' } } : null; },
          async materialize() { throw new Error('Managed Muse credentials cannot enter a native preflight'); },
        }, signal: new AbortController().signal,
      });
      try { expect(prepared.environment).toEqual({ PI_CODING_AGENT_DIR: directory }); }
      finally { await prepared.dispose(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('prepares the selected Codex binding before the native probe consumes its extension', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-preflight-auth-'));
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const declaration: AgentPreflightSessionControlsContributionV1 = PI_PREFLIGHT_SESSION_CONTROLS;
    let prepared: Awaited<ReturnType<NonNullable<typeof declaration.prepareLaunchEnvironment>>> | undefined;
    try {
      expect(declaration.prepareLaunchEnvironment).toBeTypeOf('function');
      prepared = await declaration.prepareLaunchEnvironment?.({
        environment: { PI_CODING_AGENT_DIR: directory, [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: join(directory, 'capability.json') },
        connectedAccounts: {
          watch(_purpose, listener) { void listener({ kind: 'resync', authorityChanged: true }); return { dispose() {} }; },
          async getBinding(purpose) { return purpose === PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID
            ? { purpose, service, account: { service, accountId: 'primary' }, target: { kind: 'account', displayName: 'Primary' } } : null; },
          async materialize() { throw new Error('Codex request auth must remain request scoped'); },
        },
        signal: new AbortController().signal,
      });
      const command = PI_PREFLIGHT_SESSION_CONTROLS.models.command;
      const args = command.prepareCommand?.({ accountSettings: null, environment: prepared!.environment }).args;
      expect(args).toContainEqual({ kind: 'environmentPath', key: 'PI_CODING_AGENT_DIR', relativePath: resolvePiRequestAuthExtensionPath('') });
      expect(await readFile(resolvePiRequestAuthExtensionPath(directory), 'utf8')).toContain(PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID);
      expect(JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8'))).toEqual({});
    } finally { await prepared?.dispose(); await rm(directory, { recursive: true, force: true }); }
  });

  it('preserves friendly names, nested model ids, and model-scoped Thinking support', () => {
    expect(PI_PREFLIGHT_SESSION_CONTROLS.models.parseOutput?.({
      ok: true, stdout: '', exitCode: 0,
      stderr: ['vendor diagnostic', observation([
        { provider: 'openai-codex', id: 'gpt-6-sol', name: 'GPT-6 Sol', reasoning: true },
        { provider: 'openrouter', id: 'meta/muse', name: 'Muse', reasoning: false },
      ])].join('\n'),
    })).toEqual({ source: 'static', availableModels: [
      expect.objectContaining({ id: 'openai-codex/gpt-6-sol', name: 'GPT-6 Sol', modelOptions: expect.any(Array) }),
      { id: 'openrouter/meta/muse', name: 'Muse', description: 'openrouter' },
    ] });
  });

  it.each([
    'provider model context max-out thinking images\nopenai stale 200K 4K yes no',
    JSON.stringify({ type: 'happier-pi-model-catalog', error: 'refresh-unsupported' }),
    JSON.stringify({ type: 'happier-pi-model-catalog', error: 'offline' }),
    observation([{ nonsense: true }]),
  ])('does not promote an unrefreshed or invalid catalog: %s', (stderr) => {
    expect(PI_PREFLIGHT_SESSION_CONTROLS.models.parseOutput?.({ ok: true, stdout: '', stderr, exitCode: 0 })).toBeNull();
  });

  it('labels a supported predecessor local snapshot as degraded rather than network-refreshed', () => {
    const stderr = JSON.stringify({ type: 'happier-pi-model-catalog', error: 'refresh-unsupported', models: [
      { provider: 'openai-codex', id: 'gpt-6-sol', name: 'GPT-6 Sol', reasoning: true },
    ] });
    expect(PI_PREFLIGHT_SESSION_CONTROLS.models.parseOutput?.({ ok: true, stdout: '', stderr, exitCode: 0 })).toEqual({
      source: 'static', refreshError: true,
      availableModels: [expect.objectContaining({ id: 'openai-codex/gpt-6-sol', name: 'GPT-6 Sol' })],
    });
  });

  it('preserves a confirmed empty catalog', () => {
    expect(PI_PREFLIGHT_SESSION_CONTROLS.models.parseOutput?.({ ok: true, stdout: '', stderr: observation([]), exitCode: 0 })).toEqual({ source: 'static', availableModels: [] });
  });
});
