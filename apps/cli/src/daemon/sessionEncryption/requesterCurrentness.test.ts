import fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { resolveOfflineReconnectionBackoffDelayMs } from '@/api/offline/serverConnectionErrors';
import { readRequesterHomeWithinActionLifetime } from './requesterCurrentness';
import { prepareRequesterSessionBootstrap } from './requesterSessionCredentials';
import { createActiveAccountSettingsConnectedAccountPurposeBindingStore } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { emptyConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import { createAccountSettingsConnectedAccountSecrets } from '../connectedServices/qualifiedConnectedAccountDaemonPersistence';

it('paces sustained unavailable preparation reads with the Home policy and cancels the pending wait', async () => {
  vi.useFakeTimers();
  const random = vi.spyOn(Math, 'random').mockReturnValue(1);
  const caller = new AbortController();
  let reads = 0;
  let available = false;
  const read = async () => {
    reads++;
    if (!available) throw Object.assign(new Error('Home unavailable'), { response: { status: 503 } });
    return 'prepared';
  };
  try {
    const preparation = readRequesterHomeWithinActionLifetime(read, caller.signal);
    await vi.advanceTimersByTimeAsync(0);
    // More failures than the Home policy's delay saturation count:
    // the Home policy caps its delay, never this accepted Action's lifetime.
    for (let failure = 1; failure <= 12; failure++) {
      expect(reads).toBe(failure);
      await vi.advanceTimersByTimeAsync(resolveOfflineReconnectionBackoffDelayMs(failure) - 1);
      expect(reads).toBe(failure);
      if (failure === 12) available = true;
      await vi.advanceTimersByTimeAsync(1);
    }
    await expect(preparation).resolves.toBe('prepared');
    available = false;
    const cancelled = readRequesterHomeWithinActionLifetime(read, caller.signal);
    const rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    const beforeCancellation = reads;
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await rejection;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toBe(beforeCancellation);
  } finally {
    caller.abort();
    random.mockRestore();
    vi.useRealTimers();
  }
});

it('preserves requester custody across unavailable observations and recovers safe reads inside the caller lifetime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'requester-currentness-'));
  const channel = await createRequesterCurrentnessSocketHarness();
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.fixture`;
  let current = true;
  let profileStatus = 200;
  let settingsUnavailable = false;
  let settingsVersion = 2;
  let accountSequence = 1;
  let profileReads = 0;
  let profileGate: (() => Promise<void>) | undefined;
  let releasePendingProfile: (() => void) | undefined;
  const purposes = emptyConnectedAccountCatalogRecordV1('purposes');
  const home = fastify();
  home.get('/*', async (request, reply) => {
    const path = request.url;
    if (path.endsWith('/profile')) {
      profileReads++;
      const status = profileStatus;
      profileStatus = 200;
      await profileGate?.();
      return reply.code(status).send(status === 200 ? { id: 'bob' } : { error: 'unavailable' });
    }
    if (path.endsWith('/currentness')) return { mode: 'plain', version: accountSequence,
      updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null };
    if (path.endsWith('/account/encryption')) return { mode: 'plain', updatedAt: 1 };
    if (path.endsWith('/entity-rows/connected-accounts/purposes')) return {
      status: 'present', revision: 1, content: { t: 'plain', v: purposes },
    };
    if (path === '/v2/account/settings') {
      if (settingsUnavailable) return reply.code(503).send({ error: 'unavailable' });
      return { content: { t: 'plain', v: {} }, version: settingsVersion };
    }
    throw new Error(`Unexpected requester read ${path}`);
  });
  // Real TCP is required here: Fastify's inject adapter does not interrupt a
  // held response when Axios aborts the next admission's profile request.
  const serverOrigin = await home.listen({ host: '127.0.0.1', port: 0 });
  const prepare = (signal?: AbortSignal) => prepareRequesterSessionBootstrap({ credentials: { token, encryption: null },
    attribution: { serverId: 'home', accountId: 'bob', machineId: 'machine', installationId: 'installation' },
    boundary: { serverId: 'home', serverHttpBaseUrl: serverOrigin, happyHomeDir: directory },
    // Machine admission is the external authority boundary; Account reads,
    // socket observation, Settings publication and private custody remain real.
    verifyMachineAdmissionCurrent: async () => current, signal });
  let prepared: Awaited<ReturnType<typeof prepareRequesterSessionBootstrap>> = null;
  const retryJitter = vi.spyOn(Math, 'random').mockReturnValue(0);
  try {
    prepared = await prepare();
    if (!prepared) throw new Error('Expected admitted requester');
    const bootstrap = prepared.admitted;
    const custody = bootstrap.savedSecretOperationContext;
    const snapshot = custody.readSnapshot();
    await channel.disconnect();
    await expect(custody.isCurrent()).rejects.toMatchObject({ retryable: true });
    expect(custody.readSnapshot()).toBe(snapshot);
    await channel.reconnect();
    expect(await custody.isCurrent()).toBe(true);

    settingsUnavailable = true;
    await channel.hintSettings(++settingsVersion);
    await expect(bootstrap.ensureAccountSettingsCurrent()).rejects.toMatchObject({ response: { status: 503 } });
    settingsUnavailable = false;
    expect(await bootstrap.ensureAccountSettingsCurrent()).toBe(true);

    // Team/Connected-account readers use requester encryption identity, not
    // the Account-wide cursor that also advances on unrelated writes.
    accountSequence += 1;
    expect(await custody.isCurrent()).toBe(true);

    const signal = new AbortController().signal;
    const beforeAdmittedReads = profileReads;
    profileStatus = 503;
    expect(await custody.isCurrent()).toBe(true);
    expect(await custody.commitConnectedAccountCatalog({ key: 'purposes', catalog: { status: 'ready', record: purposes, revision: 1 } })).toBe(true);
    const store = createActiveAccountSettingsConnectedAccountPurposeBindingStore({ operationContext: custody });
    expect(await readRequesterHomeWithinActionLifetime(() => store.read(signal), signal)).toEqual(purposes.value);
    const scopeKey = custody.readSnapshot()?.scopeKey;
    if (!scopeKey) throw new Error('Missing requester Account scope');
    const secrets = createAccountSettingsConnectedAccountSecrets({ expectedScopeKey: scopeKey, operationContext: custody });
    expect(await readRequesterHomeWithinActionLifetime(() => secrets.readMaterial!('missing-secret', { signal }), signal)).toBeNull();
    expect(profileReads).toBe(beforeAdmittedReads);
    // Unavailable authority is observed by the next admission, while work
    // already admitted keeps its captured custody and encryption identity.
    await expect(prepare()).rejects.toMatchObject({ code: 'project_requester_home_unavailable', retryable: true });
    let enteredProfile!: () => void;
    const entered = new Promise<void>(resolve => { enteredProfile = resolve; });
    const held = new Promise<void>(resolve => { releasePendingProfile = resolve; });
    profileGate = async () => { profileGate = undefined; enteredProfile(); await held; };
    const reader = new AbortController();
    const cancelledRead = expect(prepare(reader.signal)).rejects.toBeDefined();
    await entered;
    reader.abort();
    await cancelledRead;
    expect(custody.readSnapshot()).not.toBeNull();
    releasePendingProfile?.();
    expect(await custody.isCurrent()).toBe(true);
    profileStatus = 403;
    const beforeRefusal = profileReads;
    await expect(readRequesterHomeWithinActionLifetime(() => prepare(signal), signal)).rejects.toMatchObject({ response: { status: 403 } });
    expect(profileReads - beforeRefusal).toBe(1);
    const cancelled = new AbortController();
    cancelled.abort();
    const beforeCancellation = profileReads;
    await expect(bootstrap.isCurrent(cancelled.signal)).rejects.toBeDefined();
    await expect(readRequesterHomeWithinActionLifetime(() => custody.isCurrent(), cancelled.signal)).rejects.toBeDefined();
    await expect(store.read(cancelled.signal)).rejects.toBeDefined();
    await expect(secrets.readMaterial?.('missing-secret', { signal: cancelled.signal })).rejects.toBeDefined();
    expect(profileReads).toBe(beforeCancellation);
    const beforeColdBackground = profileReads;
    let backgroundFailure: unknown;
    profileStatus = 503;
    try { await (await prepare(signal))?.cleanupOnFailure(); }
    catch (error) { backgroundFailure = error; }
    expect(backgroundFailure).toMatchObject({ code: 'project_requester_home_unavailable', retryable: true });
    expect(profileReads - beforeColdBackground).toBe(1);
    profileStatus = 503;
    const cold = await readRequesterHomeWithinActionLifetime(() => prepare(signal), signal);
    expect(cold).not.toBeNull();
    await cold?.cleanupOnFailure();
    current = false;
    expect(await custody.isCurrent()).toBe(true);
    expect(await prepare()).toBeNull();
    await bootstrap.dispose();
    expect(await custody.isCurrent()).toBe(false);
    expect(custody.readSnapshot()).toBeNull();
  } finally {
    retryJitter.mockRestore();
    releasePendingProfile?.();
    await prepared?.cleanupOnFailure();
    await home.close();
    await channel.close();
    await rm(directory, { recursive: true, force: true });
  }
});
