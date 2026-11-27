import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { FX_PLUGIN } from '../../manifest.js';
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { createKimiConnectedAccountRuntime } from '../../../../kimi/src/connectedAccounts/runtime.js';
import { createXaiConnectedAccountRuntime } from '../../../../grok/src/connectedAccounts/runtime.js';
import { openAiConnectedAccountRuntime } from '../../../../openai/src/auth/connectedAccountRuntime.js';
import {
  KIMI_SELECTED_CODE_API_KEY_ENV,
  KIMI_CODE_API_BASE_ENV,
  XAI_SELECTED_API_KEY_ENV,
  OPENAI_SELECTED_API_KEY_ENV,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { prepareFxConnectedAccount } from './connectedAccount.js';
import { FX_TERMINAL_CONTRIBUTION } from '../terminal/contribution.js';

const rows = [
  { runtime: createKimiConnectedAccountRuntime(), credentials: { accessToken: 'fake-kimi-key', credentialKind: 'token', apiKind: 'code', apiBase: 'https://api.kimi.ai/coding/v1' }, keys: [KIMI_SELECTED_CODE_API_KEY_ENV, KIMI_CODE_API_BASE_ENV], key: 'fake-kimi-key', base: 'https://api.kimi.ai/coding/v1' },
  { runtime: createXaiConnectedAccountRuntime(), credentials: { xaiCredential: JSON.stringify({ mode: 'api-key', accessToken: 'fake-xai-key' }) }, keys: [XAI_SELECTED_API_KEY_ENV], key: 'fake-xai-key', base: 'https://api.x.ai/v1' },
  { runtime: openAiConnectedAccountRuntime, credentials: { token: 'fake-openai-key' }, keys: [OPENAI_SELECTED_API_KEY_ENV], key: 'fake-openai-key', base: 'https://api.openai.com/v1' },
];

describe('FX selected native keys', () => {
  it('prepares selected model preflight through the actual native account callback', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-fx-selected-preflight-'));
    const activation = await createPluginTestkit({ manifest: FX_PLUGIN.manifest, module: FX_PLUGIN });
    try {
      const row = rows[2]!;
      const context = { signal: new AbortController().signal, services: {}, configuration: { values: {} },
        credentials: { async get(key: string) { return row.credentials[key as keyof typeof row.credentials] ?? null; } },
      } as Parameters<ConnectedAccountRuntime['materialize']>[1];
      const material = await row.runtime.materialize({ kind: 'environment', keys: row.keys }, context);
      if (material.kind !== 'environment') throw new Error('Expected selected key environment');
      const prepare = activation.registration('agents', 'fx')!.preflightSessionControls!.prepareLaunchEnvironment!;
      const input = { environment: { HOME: home, FX_MODEL: 'ambient', AI_GATEWAY_API_KEY: 'ambient', ...material.env },
        signal: context.signal, modelId: 'selected-model', connectedAccounts: {
          getBinding: async () => null, materialize: async () => { throw new Error('The host already materialized this key'); },
          watch: () => ({ dispose() {} }),
        } };
      const prepared = await prepare(input);
      try {
        expect(prepared.environment).toMatchObject({ FX_PROVIDER: 'happier', FX_MODEL: 'selected-model', HAPPIER_FX_PROVIDER_API_KEY: row.key });
        expect(prepared.environment.AI_GATEWAY_API_KEY).toBeUndefined();
        expect(prepared.unset).toContain('AI_GATEWAY_API_KEY');
        expect(prepared.catalogConfidence).toBe('account_unverified');
        expect(JSON.parse(await readFile(join(home, '.fx/settings.json'), 'utf8'))).toMatchObject({ models: { happier: 'selected-model' } });
      } finally { await prepared.dispose(); }
    } finally { await activation.dispose(); await rm(home, { recursive: true, force: true }); }
  });

  it('keeps standard ambient credentials on the native default path', async () => {
    const environment = { values: { OPENAI_API_KEY: 'ambient', XAI_API_KEY: 'ambient', KIMI_API_KEY: 'ambient', FX_MODEL: 'ambient' } };
    expect(await prepareFxConnectedAccount(environment)).toBe(environment);
  });

  it('requires a resolved model before effects for selected keys', async () => {
    await expect(prepareFxConnectedAccount({ values: { HOME: '/private', [XAI_SELECTED_API_KEY_ENV]: 'selected', FX_MODEL: 'ambient' } })).rejects.toMatchObject({
      code: 'agent_startup_model_reconciliation_failed', details: { failureCause: { failureReason: 'model_selection_required' } },
    });
  });

  it.each(rows)('replaces saved native source and model with selected $base', async row => {
    const home = await mkdtemp(join(tmpdir(), 'happier-fx-native-keys-'));
    try {
      await mkdir(join(home, '.fx'));
      await writeFile(join(home, '.fx/settings.json'), JSON.stringify({ provider: 'gateway', credential_source: 'vercel_oidc', models: { happier: 'ambient' }, theme: 'retained' }));
      // Only persistence is a boundary fixture; selected key/mode encoding is real.
      const context = { signal: new AbortController().signal, services: {}, configuration: { values: {} },
        credentials: { async get(key: string) { return row.credentials[key as keyof typeof row.credentials] ?? null; } },
      } as Parameters<ConnectedAccountRuntime['materialize']>[1];
      const material = await row.runtime.materialize({ kind: 'environment', keys: row.keys }, context);
      if (material.kind !== 'environment') throw new Error('Expected environment');
      const plan = await FX_TERMINAL_CONTRIBUTION.resolveLaunch({ sessionId: 'selected', cwd: '/workspace', metadata: {}, modelSelection: null,
        configuration: { model: { value: 'selected-model', updatedAtMs: 1 }, mode: { value: null, updatedAtMs: 1 }, permissionIntent: { value: 'default', updatedAtMs: 1 }, options: {} },
        launchEnvironment: { values: { HOME: home, AI_GATEWAY_API_KEY: 'ambient', FX_MODEL: 'ambient', ...material.env }, unset: [] } });
      expect(plan.environment?.values).toMatchObject({ FX_PROVIDER: 'happier', FX_MODEL: 'selected-model', HAPPIER_FX_PROVIDER_API_KEY: row.key });
      expect(plan.environment?.values.AI_GATEWAY_API_KEY).toBeUndefined();
      const settings = JSON.parse(await readFile(join(home, '.fx/settings.json'), 'utf8'));
      expect(settings).toMatchObject({ provider: 'happier', models: { happier: 'selected-model' }, theme: 'retained',
        providers: { happier: { protocol: 'openai-chat-completions', base_url: row.base, auth: { type: 'bearer', env: 'HAPPIER_FX_PROVIDER_API_KEY' } } } });
      expect(settings.credential_source).toBeUndefined();
      if (process.platform !== 'win32') expect((await stat(join(home, '.fx'))).mode & 0o777).toBe(0o700);
      expect(JSON.stringify(settings)).not.toContain(row.key);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
