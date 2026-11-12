import { expect, it } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { QuotaFetchError, type ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createMuseMspProcessFixture, readMuseLoginRecording, readMuseMspProcessAudit, waitForMuseMspProcessAudit } from '../agent/testkit/mspProcess.js';
import { museConnectedAccountRuntime } from './museAccountNativeRuntime.js';

// Native 1.4.15 refresh shape observed by the isolated QA Account A probe.
const sample = { usage: { observedAtMs: 1794500585230,
  weekly: { usedPercent: 9, resetsAtMs: 1794787200000 },
  window: { usedPercent: 6, resetsAtMs: 1794513331000, windowDurationMins: 300 } },
  tierName: 'Subscription', subscriptionActive: true };

async function fixture(response: Readonly<{ result?: JsonValue; error?: JsonValue }>, key = true, hold = false) {
  const directory = await mkdtemp(join(tmpdir(), 'happier-muse-quota-test-'));
  const auditPath = join(directory, 'native.json');
  const launchPath = join(directory, 'launch.json');
  const values = new Map(Object.entries({ credentialMode: 'native', accountToken: 'synthetic-oauth-token',
    ...(key ? { inferenceKey: 'synthetic-selected-key' } : {}), nativeMechanism: '"oauth"',
    nativeApiBaseUrl: 'https://api.meta.ai/v1', nativeObtainedVia: 'device_code',
    expiresAtMs: String(Date.UTC(2100, 0, 1)) }));
  const login = await readMuseLoginRecording();
  if (!login || typeof login !== 'object' || Array.isArray(login) || !Array.isArray(login.rows)) throw new Error('Native login capture is invalid');
  const native = await createMuseMspProcessFixture({ auditPath, recording: { rows: [
    ...login.rows.slice(0, 2),
    { direction: 'send', message: { jsonrpc: '2.0', id: 100, method: 'usage/refresh', params: {} } },
    { direction: 'recv', message: { jsonrpc: '2.0', id: 100, ...response } },
  ] }, playbackSteps: [{ requestRow: 2, receiveUntilRow: hold ? 3 : 4 }] });
  let launches = 0;
  const controller = new AbortController();
  const signal = controller.signal;
  const exec = createStablePluginExecService({ signal, environment: { META_API_KEY: 'synthetic-ambient-key' },
    isOccurrenceCurrent: () => true, resolvePath: async path => typeof path === 'string' ? path : directory,
    async resolveExecutable() {
      launches++;
      const resolved = await native.resolveExecutable();
      // The OS boundary enforces the characterized accountLogin lane, retaining the real materializer/MSP/parser.
      const prelude = `const fs=require('node:fs'),path=require('node:path');
        const auth=JSON.parse(fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME,'muse/auth.json'),'utf8'));
        if(process.env.META_API_KEY || auth.providers.meta.mechanism!=='oauth' || auth.providers.meta.access_token!=='synthetic-oauth-token') throw new Error('incorrect native auth lane');
        fs.writeFileSync(${JSON.stringify(launchPath)},JSON.stringify({home:process.env.HOME,cwd:process.cwd(),config:process.env.XDG_CONFIG_HOME,keyKept:auth.providers.meta.api_key==='synthetic-selected-key'}));\n`;
      return { ...resolved, args: ['-e', prelude + resolved.args[1], '--'] };
    },
  });
  // Only credential storage and OS execution are substituted boundary services.
  const context = { signal, credentials: { async get(name: string) { return values.get(name) ?? null; } }, services: { exec } } as ConnectedAccountReadContext;
  return { context, values, controller,
    async waitForRefresh() { return waitForMuseMspProcessAudit(auditPath, audit => audit.methods.includes('usage/refresh'), { signal }); },
    launches: () => launches,
    async audit() { return readMuseMspProcessAudit(auditPath); },
    async assertCleanedUp() {
      const launch = JSON.parse(await readFile(launchPath, 'utf8'));
      expect(launch.cwd).toBe(launch.home);
      expect(launch.keyKept).toBe(key);
      expect(launch.config).toBe(join(launch.home, 'config'));
      expect(launch.home).not.toBe(process.env.HOME);
      await expect(access(launch.home)).rejects.toMatchObject({ code: 'ENOENT' });
    },
    async dispose() { await rm(directory, { recursive: true, force: true }); },
  };
}

it.each([true, false])('reads account allowance on demand through OAuth-only MSP when inference key is %s', async key => {
  const f = await fixture({ result: sample }, key);
  try {
    const before = [...f.values];
    await expect(museConnectedAccountRuntime.quota!(f.context)).resolves.toMatchObject({
      observedAtMs: sample.usage.observedAtMs, planLabel: 'Subscription', limits: [
        { id: 'weekly', used: 9, remainingPct: 91, resetsAtMs: 1794787200000 },
        { id: 'window', used: 6, remainingPct: 94, windowDurationMs: 18000000 },
      ],
    });
    expect((await f.audit()).methods).toEqual(['initialize', 'initialized', 'usage/refresh']);
    expect(f.launches()).toBe(1);
    expect([...f.values]).toEqual(before);
    await f.assertCleanedUp();
  } finally { await f.dispose(); }
});

it('hands native -32080 retryAfterMs to the existing provider backoff owner without retrying', async () => {
  const f = await fixture({ error: { code: -32080, message: 'synthetic-sensitive',
    data: { kind: 'usageRefreshRateLimited', retryable: true, retryAfterMs: 54321 } } });
  try {
    const error = await museConnectedAccountRuntime.quota!(f.context).catch(error => error);
    expect(error).toBeInstanceOf(QuotaFetchError);
    expect(error).toMatchObject({ status: 429, quotaFetchErrorCode: 'provider_backoff', retryAfterMs: 54321, providerCode: '-32080' });
    expect(String(error)).not.toContain('synthetic-sensitive');
    expect((await f.audit()).methods).toEqual(['initialize', 'initialized', 'usage/refresh']);
    await f.assertCleanedUp();
  } finally { await f.dispose(); }
});

it.each([
  { code: -32081, kind: 'usageRefreshUnavailable', retryable: false },
  { code: -32082, kind: 'usageRefreshFailed', retryable: true, failureKind: 'transient' },
])('keeps native $code as typed usage-unavailable without raw response text', async failure => {
  const { code, ...data } = failure;
  const f = await fixture({ error: { code, message: 'synthetic-sensitive', data } });
  try {
    const error = await museConnectedAccountRuntime.quota!(f.context).catch(error => error);
    expect(error).toMatchObject({ code: 'plugin_connected_account_usage_unavailable', data: { details: { code, ...data } } });
    expect(String(error)).not.toContain('synthetic-sensitive');
    await f.assertCleanedUp();
  } finally { await f.dispose(); }
});

it('leaves a key-only Account unavailable without opening an OAuth host', async () => {
  const f = await fixture({ result: sample });
  try {
    f.values.set('credentialMode', 'manual');
    await expect(museConnectedAccountRuntime.quota!(f.context)).rejects.toMatchObject({ code: 'plugin_connected_account_usage_unavailable' });
    expect(f.launches()).toBe(0);
  } finally { await f.dispose(); }
});

it('keeps an empty native usage response unavailable and disposes its host', async () => {
  const f = await fixture({ result: {} });
  try {
    await expect(museConnectedAccountRuntime.quota!(f.context)).rejects.toMatchObject({ code: 'plugin_connected_account_usage_unavailable' });
    await f.assertCleanedUp();
  } finally { await f.dispose(); }
});

it('removes the isolated OAuth home when the quota owner cancels an active refresh', async () => {
  const f = await fixture({ result: sample }, true, true);
  const pending = museConnectedAccountRuntime.quota!(f.context);
  try {
    await Promise.race([f.waitForRefresh(), pending.then(() => { throw new Error('Native refresh unexpectedly completed'); })]);
    f.controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await f.assertCleanedUp();
  } finally { f.controller.abort(); await pending.catch(() => {}); await f.dispose(); }
});
