import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentExecutionRunRuntimeContextV1, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ConnectedAccountBindingEvent, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { KIMI_CONNECTED_ACCOUNT_SERVICE } from '@happier-dev/plugins-kimi/connected-account-service';
import { GROK_CONNECTED_ACCOUNT_SERVICE } from '@happier-dev/plugins-grok/connected-account-service';
import { MUSE_ACCOUNT_SERVICE } from '@happier-dev/plugins-muse/connected-account-service';
import { GEMINI_CONNECTED_ACCOUNT_SERVICE } from '@happier-dev/plugins-gemini/connected-account-service';
import { GITHUB_CONNECTED_ACCOUNT_SERVICE } from '@happier-dev/plugins-scm-github/connected-account-service';
import { createKimiConnectedAccountRuntime } from '../../../../../kimi/src/connectedAccounts/runtime.js';
import { createXaiConnectedAccountRuntime } from '../../../../../grok/src/connectedAccounts/runtime.js';
import { museConnectedAccountRuntime } from '../../../../../muse/src/connectedAccounts/museAccountRuntime.js';
import { geminiConnectedAccountRuntime } from '../../../../../gemini/src/connectedAccounts/runtime.js';
import { githubAccountCredentialRuntime } from '../../../../../scm-github/src/auth/credentialMaterialization.js';
import { activate, PLUGIN_MANIFEST } from '../../../index.js';
import { OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES, ohMyPiPurposeOwnedEnvironmentKeys } from './accountPurposes.js';

type DeliveryCase = Readonly<{
  purpose: string;
  provider: string;
  service: Readonly<{ pluginId: string; localId: string }>;
  runtime: Pick<ConnectedAccountRuntime, 'materialize'>;
  credentials: Readonly<Record<string, string>>;
  nativeKey: string;
  expectedValue: string | Readonly<Record<string, string>>;
  expectedBaseUrl?: string;
}>;

const cases: readonly DeliveryCase[] = [{
  purpose: 'gemini', provider: 'google', service: GEMINI_CONNECTED_ACCOUNT_SERVICE,
  runtime: geminiConnectedAccountRuntime,
  credentials: { apiKey: 'fake-gemini-key' },
  nativeKey: 'GEMINI_API_KEY', expectedValue: 'fake-gemini-key',
}, {
  purpose: 'kimi-code', provider: 'kimi-code', service: KIMI_CONNECTED_ACCOUNT_SERVICE,
  runtime: createKimiConnectedAccountRuntime(),
  credentials: { accessToken: 'fake-kimi-code', credentialKind: 'token', apiKind: 'code', apiBase: 'https://api.kimi.ai/coding/v1' },
  nativeKey: 'KIMI_API_KEY', expectedValue: 'fake-kimi-code', expectedBaseUrl: 'https://api.kimi.ai/coding/v1',
}, {
  purpose: 'kimi-oauth', provider: 'kimi-code', service: KIMI_CONNECTED_ACCOUNT_SERVICE,
  runtime: createKimiConnectedAccountRuntime(),
  credentials: { accessToken: 'fake-kimi-oauth', credentialKind: 'oauth', refreshToken: 'fake-root-refresh', apiKind: 'code', apiBase: 'https://api.kimi.ai/coding/v1' },
  nativeKey: 'KIMI_API_KEY', expectedValue: 'fake-kimi-oauth', expectedBaseUrl: 'https://api.kimi.ai/coding/v1',
}, {
  purpose: 'xai-subscription', provider: 'xai-oauth', service: GROK_CONNECTED_ACCOUNT_SERVICE,
  runtime: createXaiConnectedAccountRuntime(),
  credentials: { xaiCredential: JSON.stringify({ mode: 'subscription', accessToken: 'fake-xai-oauth', refreshToken: 'fake-root-refresh' }) },
  nativeKey: 'XAI_OAUTH_TOKEN', expectedValue: 'fake-xai-oauth',
}, {
  purpose: 'xai-key', provider: 'xai', service: GROK_CONNECTED_ACCOUNT_SERVICE,
  runtime: createXaiConnectedAccountRuntime(),
  credentials: { xaiCredential: JSON.stringify({ mode: 'api-key', accessToken: 'fake-xai-key' }) },
  nativeKey: 'XAI_API_KEY', expectedValue: 'fake-xai-key',
}, {
  purpose: 'muse-subscription', provider: 'muse-code', service: MUSE_ACCOUNT_SERVICE,
  runtime: museConnectedAccountRuntime,
  credentials: { credentialMode: 'native', nativeMechanism: '"oauth"', accountToken: 'fake-muse-oauth', inferenceKey: 'fake-muse-inference' },
  nativeKey: 'MUSE_CODE_CREDENTIAL', expectedValue: { oauthAccessToken: 'fake-muse-oauth', apiKey: 'fake-muse-inference' },
}, {
  purpose: 'meta', provider: 'meta', service: MUSE_ACCOUNT_SERVICE,
  runtime: museConnectedAccountRuntime,
  credentials: { credentialMode: 'api-key', inferenceKey: 'fake-meta-key' },
  nativeKey: 'META_API_KEY', expectedValue: 'fake-meta-key',
}, {
  purpose: 'github-copilot', provider: 'github-copilot', service: GITHUB_CONNECTED_ACCOUNT_SERVICE,
  runtime: githubAccountCredentialRuntime,
  credentials: { token: 'github_pat_accepted' },
  nativeKey: 'COPILOT_GITHUB_TOKEN', expectedValue: 'github_pat_accepted',
}];

describe('Oh My Pi service producer to native launch', () => {
  it.each(cases)('delivers the real $purpose materializer to Sessions and finite Runs without refresh or exchange', async row => {
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const home = mkdtempSync(join(tmpdir(), 'n-omp-producer-'));
    try {
      const factory = plugin.registration('agents', 'ohmypi')?.factory;
      if (!factory) throw new Error('Oh My Pi Agent registration is missing');
      const signal = new AbortController().signal;
      const runtime = await factory({ plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, agent: { id: 'ohmypi' }, signal });
      const account = { service: row.service, accountId: 'fake-selected' };
      const requestHttp = vi.fn(async () => { throw new Error('Selected credential delivery must not contact the vendor'); });
      // Credential custody and HTTP are real host boundaries; producer codecs remain real.
      const materializationContext = { signal, invokedAtMs: 1000, account,
        credentials: { async get(key: string) { return row.credentials[key] ?? null; } },
        configuration: { target: { kind: 'account', account, modeId: 'api-key' }, revision: '1', values: {}, async getSecret() { return null; } },
        services: { http: { request: requestHttp } },
      } as unknown as Parameters<ConnectedAccountRuntime['materialize']>[1];

      for (const finite of [false, true]) {
        const native = { async send() { return { status: 'admitted' as const }; }, async stop() { return { status: 'requested' as const }; },
          watch: () => ({ dispose() {} }), async dispose() {} };
        const open = vi.fn(async (_request: { launchEnvironment?: { values: Readonly<Record<string, string>>; unset?: readonly string[] } }) => native);
        const servicePurposes = OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES.filter(declaration =>
          declaration.service.pluginId === row.service.pluginId && declaration.service.localId === row.service.localId);
        const ownedEnvironmentKeys = servicePurposes.flatMap(ohMyPiPurposeOwnedEnvironmentKeys);
        const materialize = vi.fn(async (purpose: string, request: Parameters<ConnectedAccountRuntime['materialize']>[0]) => {
          if (!servicePurposes.some(declaration => declaration.purpose === purpose)) throw new Error('Unexpected service acquisition');
          return row.runtime.materialize(request, materializationContext);
        });
        const context = { signal, services: { connectedAccounts: {
          async getBinding(purpose: string) { return servicePurposes.some(declaration => declaration.purpose === purpose)
            ? { purpose, service: row.service, account, target: { kind: 'account' as const, displayName: 'Selected' } } : null; },
          materialize,
          watch(_purpose: string, listener: (event: ConnectedAccountBindingEvent) => void | Promise<void>) {
            queueMicrotask(() => void listener({ kind: 'resync', authorityChanged: false }));
            return { dispose() {} };
          },
        } }, protocols: { acp: { open, openExecutionRunV1: open } } };
        const common = { kind: 'create' as const, cwd: '/workspace', configuration: {
          model: { value: `${row.provider}/selected`, updatedAtMs: 1 }, mode: { value: null, updatedAtMs: 1 },
          permissionIntent: { value: null, updatedAtMs: 1 }, options: {},
        }, launchEnvironment: { values: { ...Object.fromEntries(ownedEnvironmentKeys.map(key => [key, 'fake-ambient'])),
          PI_CODING_AGENT_DIR: home, OMP_PROFILE: 'ambient-omp', PI_PROFILE: 'ambient-pi' }, unset: [] } };
        const opened = finite
          ? await runtime.sessions.executionRunContextV1!.open({ ...common, runId: 'fake-run', profile: { pluginId: PLUGIN_MANIFEST.id, localId: 'default' }, input: { text: 'Work' } }, context as unknown as AgentExecutionRunRuntimeContextV1)
          : await runtime.sessions.open({ ...common, sessionId: 'fake-session' }, context as unknown as AgentSessionRuntimeContext);
        try {
          const launchEnvironment = open.mock.calls[0]?.[0].launchEnvironment;
          const values = launchEnvironment?.values;
          const delivered = values?.[row.nativeKey];
          expect(typeof row.expectedValue === 'string' ? delivered : JSON.parse(delivered ?? 'null')).toEqual(row.expectedValue);
          expect(values).not.toHaveProperty('OMP_PROFILE');
          expect(values).not.toHaveProperty('PI_PROFILE');
          expect(launchEnvironment?.unset).toEqual(expect.arrayContaining(['OMP_PROFILE', 'PI_PROFILE']));
          for (const key of servicePurposes.flatMap(declaration => declaration.nativeRoutes.flatMap(route => [route.materializationKey, route.launchEnvironmentKey]))) {
            if (key !== row.nativeKey) {
              expect(values).not.toHaveProperty(key);
              expect(launchEnvironment?.unset).toContain(key);
            }
          }
          const nativeConfiguration = JSON.parse(readFileSync(join(home, 'models.yml'), 'utf8'));
          expect(nativeConfiguration).toEqual({ providers: { [row.provider]: { apiKey: row.nativeKey,
            ...(row.expectedBaseUrl ? { baseUrl: row.expectedBaseUrl } : {}),
          } } });
          for (const secret of Object.values(row.credentials)) {
            if (secret.startsWith('fake-') || secret.startsWith('github_pat_')) expect(JSON.stringify(nativeConfiguration)).not.toContain(secret);
          }
          expect(JSON.stringify(values)).not.toContain('fake-root-refresh');
          expect(requestHttp).not.toHaveBeenCalled();
          expect(materialize).toHaveBeenCalledTimes(1);
        } finally { await opened.dispose(); }
      }
    } finally {
      await plugin.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
