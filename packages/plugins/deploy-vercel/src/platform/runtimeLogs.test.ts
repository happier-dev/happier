import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { DeploymentTargetLogsResultV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import type { HttpStreamRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';
import { activateAccount } from '../account.js';
import { openApiTypedRuntimeLog } from './fixtures/runtimeLogResponse.js';

const account = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'fixture' };
const input = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
  targetLinkId: 'link', expectedTargetLinkRevision: 1, deploymentId: 'receipt', expectedDeploymentRevision: 1,
  actionOperationId: 'operation', providerDeploymentId: 'dpl_exact', credentialRef: account,
  credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
    consumer: { pluginId: entry.manifest.id, localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' }, target: { kind: 'account', account } },
  providerIdentity: { providerAccountId: 'team_exact', providerResourceId: 'prj_exact', providerEnvironment: 'production' },
  providerEnvironment: { kind: 'production' } };
// Derived UTF-8/frame mutation of the recorded official example and typed schema.
const normalizedRow = { ...openApiTypedRuntimeLog, message: 'héllo' };
const row = { ...normalizedRow, privateVendorField: 'omitted' };

function expectRuntimePage(value: unknown, expectedRow: typeof normalizedRow): void {
  const result = DeploymentTargetLogsResultV1ProtocolSchema.parse(value);
  expect(result).toEqual({ kind: 'page', page: { sourceRevision: 'dpl_exact', rowId: expectedRow.rowId,
    text: expect.any(String), nextCursor: null, truncated: true } });
  if (result.kind !== 'page') throw new Error('Expected finite runtime page');
  expect(JSON.parse(result.page.text)).toEqual(expectedRow);
}

it.each([normalizedRow, { ...normalizedRow, rowId: '' }])('preserves every normalized runtime fact, including row identity %j', async expectedRow => {
  const http = createPluginHttpFixture({ async request() { throw new Error('No buffered runtime HTTP'); },
    async requestStream(request) { return { status: 200, finalUrl: request.url, headers: {},
      chunks: (async function* () { yield new TextEncoder().encode(`${JSON.stringify({ ...expectedRow, privateVendorField: 'omitted' })}\n`); })(), async dispose() {} }; } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const { pages } = await follow(kit);
    expect(pages).toHaveLength(1);
    expectRuntimePage(pages[0], expectedRow);
  } finally { await kit.dispose(); }
});

it.each(['daemon-root', 'portable-account'] as const)('follows normalized finite runtime pages with backpressure and disposal on %s', async target => {
  let requests = 0;
  let advanced = 0;
  let disposals = 0;
  let firstDelivered!: () => void;
  const first = new Promise<void>(resolve => { firstDelivered = resolve; });
  let releaseFirst!: () => void;
  const firstAccepted = new Promise<void>(resolve => { releaseFirst = resolve; });
  let secondDelivered!: () => void;
  const second = new Promise<void>(resolve => { secondDelivered = resolve; });
  const pages: unknown[] = [];
  const http = createPluginHttpFixture({ async request() { throw new Error('No buffered runtime HTTP'); },
    async requestStream(request, options) {
      requests++;
      return { status: 200, finalUrl: request.url, headers: {}, chunks: (async function* () {
        yield new TextEncoder().encode(`${JSON.stringify(row)}\n`);
        advanced++;
        yield new TextEncoder().encode(`${JSON.stringify({ ...row, rowId: 'next', message: 'Second frame' })}\n`);
        advanced++;
        await new Promise<never>((_resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      })(), async dispose() { disposals++; } };
    } });
  const kit = await createPluginTestkit({ manifest: entry.manifest,
    module: target === 'daemon-root' ? entry : { ...entry, activateAccount }, services: { http } });
  let subscription: Awaited<ReturnType<typeof kit.observeAction>> | undefined;
  try {
    subscription = await kit.observeAction('runtime-logs-read', input, Object.assign(() => {
      throw new Error('Runtime frames must be delivered rather than invalidating a fresh HTTP read');
    }, { retire() {}, async emit(value: unknown) {
      pages.push(value);
      if (pages.length === 1) { firstDelivered(); await firstAccepted; }
      else secondDelivered();
    } }));
    await first;
    expect(advanced).toBe(0); // The downstream page acknowledgement controls vendor iteration.
    expect(requests).toBe(1);
    releaseFirst();
    await second;
    await subscription.dispose();
    expect(disposals).toBe(1);
    expect(pages).toHaveLength(2);
    expectRuntimePage(pages[0], normalizedRow);
    expectRuntimePage(pages[1], { ...normalizedRow, rowId: 'next', message: 'Second frame' });
    expect(requests).toBe(1); // Follow does not issue finite readResource re-reads per page.
  } finally { releaseFirst?.(); await subscription?.dispose(); await kit.dispose(); }
});

it('retains a delivered finite runtime page when a later vendor frame is malformed', async () => {
  let disposed = 0;
  let end!: (error?: unknown) => void;
  const ended = new Promise<unknown>(resolve => { end = resolve; });
  const pages: unknown[] = [];
  const http = createPluginHttpFixture({ async request() { throw new Error('No buffered runtime HTTP'); },
    async requestStream(request) { return { status: 200, finalUrl: request.url, headers: {},
      chunks: (async function* () {
        yield new TextEncoder().encode(`${JSON.stringify(row)}\n`);
        yield new TextEncoder().encode('{"provider-private": invalid}\n');
      })(), async dispose() { disposed++; } }; } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const subscription = await kit.observeAction('runtime-logs-read', input, Object.assign(() => {}, {
      retire: end, async emit(value: unknown) { pages.push(value); },
    }));
    await expect(ended).resolves.toMatchObject({ code: 'provider_response_invalid' });
    await subscription.dispose();
    expect(pages).toHaveLength(1);
    expectRuntimePage(pages[0], normalizedRow);
    expect(disposed).toBe(1);
  } finally { await kit.dispose(); }
});

/** Follow is the only streaming read: collect what it emits until it retires (EOF, delimiter or failure). */
async function follow(kit: Awaited<ReturnType<typeof createPluginTestkit>>) {
  const pages: unknown[] = [];
  let end!: (error?: unknown) => void;
  const retired = new Promise<unknown>(resolve => { end = resolve; });
  let subscription: Awaited<ReturnType<typeof kit.observeAction>>;
  // A refusal before the stream opens rejects the follow itself; later failures retire it.
  try { subscription = await kit.observeAction('runtime-logs-read', input, Object.assign(() => {}, {
    retire: end, async emit(value: unknown) { pages.push(value); },
  })); } catch (cause) { return { pages, cause }; }
  const cause = await retired;
  await subscription.dispose();
  return { pages, cause };
}

it('answers a one-shot read at once as follow-only, without opening the live stream (ORCH-TOP 01:23Z)', async () => {
  // Vercel runtime logs are a live tail with no history; a direct read used to wait up to 5 minutes (COR4R-163).
  let streams = 0;
  const http = createPluginHttpFixture({ async request() { throw new Error('unexpected buffered HTTP'); },
    async requestStream() { streams++; throw new Error('A one-shot runtime read must not open the live stream'); } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    expect(DeploymentTargetLogsResultV1ProtocolSchema.parse(await kit.invokeAction('runtime-logs-read', input)))
      .toEqual({ kind: 'unavailable', reason: 'follow_only' });
    expect(streams).toBe(0);
  } finally { await kit.dispose(); }
});

it.each(['daemon-root', 'portable-account'] as const)('normalizes a split UTF-8 runtime frame through the Account follow on %s', async target => {
  const requests: HttpStreamRequest[] = [];
  let disposed = false;
  let advancedAfterFrame = false;
  const http = createPluginHttpFixture({ async request() { throw new Error('runtime logs require streaming HTTP'); },
    async requestStream(request) {
      requests.push(request);
      return { status: 200, finalUrl: request.url, headers: { 'content-type': 'application/stream+json' },
        chunks: (async function* () {
          const bytes = new TextEncoder().encode(`${JSON.stringify(row)}\n`);
          for (const byte of bytes) yield new Uint8Array([byte]);
          advancedAfterFrame = true;
        })(),
        async dispose() { disposed = true; } };
    } });
  const kit = await createPluginTestkit({ manifest: entry.manifest,
    module: target === 'daemon-root' ? entry : { ...entry, activateAccount }, services: { http } });
  try {
    const { pages } = await follow(kit);
    expect(pages).toHaveLength(1);
    expectRuntimePage(pages[0], normalizedRow);
    expect(advancedAfterFrame).toBe(true);
    expect(disposed).toBe(true);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(new URL(request.url).pathname).toBe('/v1/projects/prj_exact/deployments/dpl_exact/runtime-logs');
    expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({ teamId: 'team_exact', format: 'lines' });
    expect(request).toMatchObject({ method: 'GET', redirect: 'error', headers: { accept: 'application/stream+json' },
      credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'deploy.manage', origin: 'https://api.vercel.com', method: 'GET', headerNames: ['authorization'] } });
    expect(request).not.toHaveProperty('timeoutMs');
  } finally { await kit.dispose(); }
});

it.each([
  { status: 403, body: 'private provider error', code: 'deployment_access_denied' },
  { status: 404, body: '', code: 'deployment_unavailable' },
  { status: 200, body: '{"private":"raw malformed', code: 'provider_response_invalid' },
])('disposes failed runtime reads without exposing vendor bytes ($status)', async sample => {
  let disposed = false;
  const http = createPluginHttpFixture({ async request() { throw new Error('unexpected buffered HTTP'); },
    async requestStream(request) { return { status: sample.status, finalUrl: request.url, headers: {},
      chunks: (async function* () { yield new TextEncoder().encode(sample.body); })(),
      async dispose() { disposed = true; } }; } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const { pages, cause } = await follow(kit);
    expect(pages).toHaveLength(0);
    expect(cause).toMatchObject({ code: sample.code });
    expect(JSON.stringify(cause)).not.toContain('private');
    expect(disposed).toBe(true);
  } finally { await kit.dispose(); }
});

it('ends at the vendor window delimiter instead of returning it as a log row (COR4R-163 live)', async () => {
  // Live: .project/tmp/COR4R-163/logs-runtime-cli2.json — after its 5-minute live window Vercel sends this
  // control row; it was returned to the person as a runtime log line.
  const delimiter = { timestampInMs: 1794786702678, rowId: '', level: 'error', message: 'Exceeded query duration limit of 5 minutes',
    messageTruncated: false, domain: '', source: 'delimiter', requestMethod: '', requestPath: '', responseStatusCode: 0 };
  const http = createPluginHttpFixture({ async request() { throw new Error('unexpected buffered HTTP'); },
    async requestStream(request) { return { status: 200, finalUrl: request.url, headers: {},
      chunks: (async function* () { yield new TextEncoder().encode(`${JSON.stringify(delimiter)}\n`); })(),
      async dispose() {} }; } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const { pages, cause } = await follow(kit);
    expect(pages).toHaveLength(0);
    expect(cause).toMatchObject({ code: 'service_unavailable' });
  } finally { await kit.dispose(); }
});
