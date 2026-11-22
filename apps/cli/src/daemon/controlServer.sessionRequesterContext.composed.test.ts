import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  FeaturesResponseSchema,
} from '@happier-dev/protocol';
import { BrowserCommandDispatchResultV1Schema } from '@happier-dev/protocol/browser/control/v1';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createDaemonSessionMutationCustody } from '@/daemon/connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { createDaemonRuntimeActionExecutor } from '@/daemon/runtimeActionExecutor';
import { createRequesterSessionAccountContextCustody } from '@/daemon/sessionEncryption/requesterSessionAccountContextCustody';
import {
  createRequesterSessionRuntimeContextResolver,
  type AdmittedRequesterSessionBootstrap,
  type RequesterSessionRuntimeContext,
} from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import type { TrackedSession } from '@/daemon/types';
import { createDaemonControlApp } from './controlServer';
import { buildDaemonControlHttpHeaders } from './controlHttp';
import { BROWSER_RUNTIME_ACTION_CONTROL_PATH } from './browser/actions/controlTransport';
import { createBrowserRoutePublication } from './browser/control/routePublication';
import { createBrowserProfileStore } from './browser/profiles/store';
import { createBrowserStoragePartitionOwner } from './browser/storage/partitions';
import { createProductBrowserSidecarControlAdapterFactory } from './browser/sidecar/productSource';
import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from './browser/sidecar/launchOwner';
import type { BrowserSidecarCdpEventSubscriber } from './browser/sidecar/controlAdapter';
import type { BrowserDaemonControlRoutes } from './browser/control/routes';
import type { BrowserRecordingDaemonRuntime } from './browser/recording/runtime';
import { createFfmpegBrowserRecordingStreamFrameEncoderFactory } from './recording/ffmpegStreamEncoder';

const environment = vi.hoisted(() => ({ home: '' }));
vi.mock('@/configuration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return {
    ...actual,
    configuration: new Proxy(actual.configuration, {
      get(target, key, receiver) {
        if (environment.home && key === 'happyHomeDir') return environment.home;
        if (environment.home && key === 'activeServerDir')
          return join(environment.home, 'server');
        if (environment.home && key === 'logsDir')
          return join(environment.home, 'logs');
        return Reflect.get(target, key, receiver);
      },
    }),
  };
});

const OWNER_SESSION = 'owner-session';
const GUEST_SESSION = 'guest-session';
const bearerFor = {
  [OWNER_SESSION]: 'owner-fixture',
  [GUEST_SESSION]: 'guest-fixture',
} as const;
const guestAttribution = {
  serverId: 'home-profile',
  accountId: 'guest',
  machineId: 'machine',
  installationId: 'installation',
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A guest's Agent reaches the daemon through the Session-local control ingress
 * (master control token, the Session process names its own Session). The ingress,
 * machine core's requester custody and resolver, the Browser and recording owners
 * and the media host are real. Boundaries: Home over local HTTP, the browser
 * process/CDP, ffmpeg, and the sealed on-disk Session-birth store (`recoverBootstrap`)
 * plus the requester runtime factory that would open Home clients.
 */
async function createFixture(guest: 'withdrawn' | 'has_access') {
  const root = await mkdtemp(join(tmpdir(), 'control-requester-ingress-'));
  environment.home = root;
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const metadata = createTestMetadata({ path: root, machineId: 'machine' });
  const sessionFor = (sessionId: string) => ({
    ...createSessionNotificationContextFixture(sessionId),
    encryptionMode: 'plain',
    metadataLayoutVersion: 1,
    metadata: JSON.stringify({ v: 1 }),
    ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({
      v: 1,
      workspace: metadata,
    }),
  });
  const reads: { bearer: string; sessionId: string }[] = [];
  const messages: { bearer: string; sessionId: string }[] = [];
  const server = createServer(async (request, response) => {
    const bearer = request.headers.authorization ?? '';
    response.setHeader('Content-Type', 'application/json');
    const match = /^\/v2\/sessions\/([^/?]+)/.exec(request.url ?? '');
    if (match) {
      const sessionId = decodeURIComponent(match[1]!);
      reads.push({ bearer, sessionId });
      // Home answers only the Session's own Account.
      if (
        bearer !== `Bearer ${bearerFor[sessionId as keyof typeof bearerFor]}`
      ) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      if (request.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
          string,
          unknown
        >;
        messages.push({ bearer, sessionId });
        response.end(
          JSON.stringify({
            didWrite: true,
            message: {
              id: 'message',
              seq: 1,
              localId: body.localId,
              content: body.content,
              createdAt: 1,
              updatedAt: 1,
            },
          }),
        );
      } else response.end(JSON.stringify({ session: sessionFor(sessionId) }));
    } else if (request.url?.includes('encryption/currentness')) {
      response.end(
        JSON.stringify({
          mode: 'plain',
          version: 1,
          updatedAt: 0,
          signingKeyFingerprint: null,
          contentKeyFingerprint: null,
        }),
      );
    } else response.end(JSON.stringify({ mode: 'plain', updatedAt: 0 }));
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  cleanups.push(
    () =>
      new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture did not bind');
  const serverBaseUrl = `http://127.0.0.1:${address.port}`;

  // The guest's Session after a daemon restart: attribution retained, requester context not yet resolved.
  const guestTracked = {
    trackingKey: legacyPidSessionTrackingKey(4243),
    startedBy: 'daemon',
    pid: 4243,
    happySessionId: GUEST_SESSION,
    requesterWorkAttributionV1: guestAttribution,
  } as unknown as TrackedSession;
  const ownerTracked = {
    trackingKey: legacyPidSessionTrackingKey(4242),
    startedBy: 'daemon',
    pid: 4242,
    happySessionId: OWNER_SESSION,
  } as unknown as TrackedSession;
  const trackedSessions = new Map([
    [ownerTracked.trackingKey, ownerTracked],
    [guestTracked.trackingKey, guestTracked],
  ]);
  const recoveries: string[] = [];
  const guestBootstrap = {
    attribution: guestAttribution,
    homeServerIdentityId: 'home',
    serverHttpBaseUrl: serverBaseUrl,
    accountEncryptionMode: 'plain',
    credentials: { token: bearerFor[GUEST_SESSION], encryption: null },
    getBoundSessionId: () => GUEST_SESSION,
    savedSecretOperationContext: {
      machineAdmission: {
        actorAccountId: 'guest',
        custodianAccountId: 'owner',
        role: 'use',
      },
      withdrawCatalog: () => {},
    },
  } as unknown as AdmittedRequesterSessionBootstrap;
  const resolveRequesterSessionRuntimeContext =
    createRequesterSessionRuntimeContextResolver({
      trackedSessions,
      // test-policy-boundary: the requester runtime factory opens Home clients for the recovered birth.
      getCreateRuntime: () => async (bootstrap) =>
        ({
          bootstrap,
          isCurrent: async () => true,
          dispose: async () => {},
        }) as unknown as RequesterSessionRuntimeContext,
      // test-policy-boundary: the sealed on-disk Session-birth store; a withdrawn guest's recovery is refused.
      recoverBootstrap: async ({ sessionId }) => {
        recoveries.push(sessionId);
        return sessionId === GUEST_SESSION && guest === 'has_access'
          ? guestBootstrap
          : null;
      },
    });
  const sessionAccounts = createRequesterSessionAccountContextCustody({
    trackedSessions,
    serverId: 'home-profile',
    machineId: 'machine',
    externalActionAccountId: 'owner',
    isRetired: () => false,
    resolveRequesterSessionRuntimeContext,
    releaseRequesterSessionRuntimeContext: async () => {},
  });

  const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
  const profiles = createBrowserProfileStore({
    storageRootDirectory: root,
    partitionOwner: createBrowserStoragePartitionOwner({
      storageRootDirectory: root,
    }),
  });
  const readSessionAccountId = (id: string) =>
    id === GUEST_SESSION ? 'guest' : id === OWNER_SESSION ? 'owner' : null;
  const factory = createProductBrowserSidecarControlAdapterFactory({
    profileStore: profiles,
    readSessionAccountId,
    resolveManagedCandidate: async () => ({
      source: 'managedBrowserPackage',
      executablePath: '/fixture/chrome',
      discoveryKind: 'managedRuntime',
      available: true,
      provenance: {
        origin: 'managed_package',
        pinnedVersion: '127.0.6533.88',
        channel: 'stable',
        integrityDigest: `sha256:${'a'.repeat(64)}`,
        license: 'BSD-3-Clause',
      },
    }),
    createLaunchOwnerFactory: (input) =>
      createBrowserSidecarLaunchOwnerControlAdapterFactory({
        ...input,
        // Genuine OS/process and CDP boundaries.
        spawnProcess: () => {
          const child = new EventEmitter();
          const stderr = new PassThrough();
          return Object.assign(child, {
            pid: 4242,
            stderr,
            stdio: [null, null, stderr, new PassThrough(), new PassThrough()],
            kill: () => {
              child.emit('exit', 0, 'SIGTERM');
              return true;
            },
          });
        },
        connectTransport: async () => ({
          transport: {
            openPage: async () => ({ targetId: 'target', sessionId: 'cdp' }),
            dispatchBrowserCommand: async () => ({ success: true }),
            subscribeCdpEvents: (listener) => {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
            dispatchPageCommand: async (command) => {
              if (command.method === 'Page.getFrameTree')
                return { frameTree: { frame: { id: 'main' } } };
              if (command.method === 'Page.addScriptToEvaluateOnNewDocument')
                return { identifier: 'overlay' };
              if (command.method === 'Page.createIsolatedWorld')
                return { executionContextId: 1 };
              if (command.method === 'Page.startScreencast')
                for (const listener of listeners)
                  listener({
                    method: 'Page.screencastFrame',
                    sessionId: 'cdp',
                    params: {
                      sessionId: 1,
                      data: Buffer.from('fixture-jpeg').toString('base64'),
                    },
                  });
              return {};
            },
          },
        }),
      }),
  });
  const encoder = createFfmpegBrowserRecordingStreamFrameEncoderFactory({
    workingDirectory: root,
    resolveFfmpegBinaryPath: async () => '/fixture/ffmpeg',
    spawnFfmpeg: (_binary, args) => {
      const child = new EventEmitter();
      const stdin = new Writable({
        write(_bytes, _encoding, done) {
          done();
        },
        final(done) {
          void writeFile(
            args.at(-1)!,
            Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]),
          ).then(() => {
            done();
            child.emit('close', 0, null);
          }, done);
        },
      });
      queueMicrotask(() => child.emit('spawn'));
      return Object.assign(child, {
        stdin,
        kill: () => {
          child.emit('close', null, 'SIGKILL');
          return true;
        },
      });
    },
  });
  let recording: BrowserRecordingDaemonRuntime | null = null;
  let control: BrowserDaemonControlRoutes | null = null;
  const ownerCustody = createDaemonSessionMutationCustody({
    credentials: { token: bearerFor[OWNER_SESSION], encryption: null },
  });
  cleanups.push(() => ownerCustody.close());
  const features = FeaturesResponseSchema.parse({
    features: {
      browser: {
        enabled: true,
        viewTargets: { enabled: true },
        internal: { enabled: true },
        sidecar: { enabled: true },
        recording: { enabled: true, attachments: { enabled: true } },
      },
    },
  });
  const publication = createBrowserRoutePublication({
    params: {
      machineId: 'machine',
      credentials: { token: bearerFor[OWNER_SESSION], encryption: null },
      serverBaseUrl,
      currentMachineHost: metadata.host,
      currentMachineHomeDir: metadata.homeDir,
      processEnv: {},
      getApiMachineForSessions: () => null,
      browserSidecarControlAdapterFactory: factory,
      browserRecordingStreamFrameEncoderFactory: encoder,
      readMachineMemory: () => ({
        reported: true,
        totalBytes: 8 * 1024 ** 3,
        availableBytes: 8 * 1024 ** 3,
        usedBytes: 0,
        pressure: { level: 'calm', source: 'none' },
      }),
      daemonSessionMutationCustody: ownerCustody,
      onBrowserControlRoutesReady: (value) => {
        control = value;
      },
      onBrowserRecordingRuntimeReady: (value) => {
        recording = value;
      },
    },
    readSessionAccountId,
    sessionAccounts,
    runtimeActionRouteProviderTarget: {},
    setGuardBrowserResourceOwner: () => {},
    shutdownSignal: new AbortController().signal,
    resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }),
  });
  cleanups.push(() => publication.dispose());
  await publication.refreshBrowserRouteOwners();

  const app = createDaemonControlApp({
    getChildren: () => [...trackedSessions.values()],
    machineId: 'machine',
    controlToken: 'control-token',
    stopSession: async () => ({ status: 'not_found' }),
    spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
    requestShutdown: () => {},
    onHappySessionWebhook: () => {},
    withSessionAccountContext: sessionAccounts.withSessionAccountContext,
    runtimeActionExecute: createDaemonRuntimeActionExecutor({
      env: {},
      resolveRouteOwners: () => ({
        browserControl: control,
        browserRecording: recording?.routes,
      }),
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }),
    }),
  });
  cleanups.push(() => app.close());

  const post = async (sessionId: string, actionId: string, input: unknown) =>
    (
      await app.inject({
        method: 'POST',
        url: BROWSER_RUNTIME_ACTION_CONTROL_PATH,
        headers: buildDaemonControlHttpHeaders('control-token'),
        payload: { actionId, input, sessionId, approvalAdmitted: true },
      })
    ).json().result as Record<string, unknown>;
  const openView = async (sessionId: string) => {
    const opened = await post(sessionId, 'browser.view.open', {
      kind: 'openView',
      commandId: `open-${sessionId}`,
      browserSessionId: sessionId,
      viewId: `view-${sessionId}`,
      platform: 'web',
      target: {
        kind: 'externalUrl',
        targetId: 'fixture',
        url: 'https://example.test',
      },
    });
    const parsed = BrowserCommandDispatchResultV1Schema.safeParse(opened);
    const profileId =
      parsed.success && parsed.data.status === 'dispatched'
        ? parsed.data.events.find((event) => event.kind === 'sessionCreated')
            ?.profileId
        : undefined;
    return { opened, profileId };
  };
  const startRecording = (
    sessionId: string,
    profileId: string | undefined,
    recordingId: string,
    mediaSessionId: string,
  ) =>
    post(sessionId, 'browser.recording.start', {
      browserSessionId: sessionId,
      viewId: `view-${sessionId}`,
      profileId: profileId ?? 'unopened',
      targetKind: 'externalUrl',
      adapterKind: 'chromiumSidecar',
      renderEngineKind: 'streamedSurface',
      captureKind: 'cdpScreencast',
      fidelity: 'cdp',
      navigationGeneration: 0,
      mimeType: 'video/webm',
      retentionClass: 'preSend',
      recordingId,
      mediaTarget: { sessionId: mediaSessionId, messageLocalId: recordingId },
    });
  // A privileged page is Manage-only (`requiredMachineRoleForBrowserAction`).
  const navigatePrivileged = (sessionId: string) =>
    post(sessionId, 'browser.automation.navigate', {
      v: 1, automationRequestId: `privileged-${sessionId}`, browserSessionId: sessionId,
      viewId: `view-${sessionId}`, navigationGeneration: 0, requestedBy: 'agent',
      requesterRef: { kind: 'agent', id: 'guest-agent' }, actionKind: 'navigate',
      payload: { url: 'chrome://version/' }, timeoutMs: 30_000,
    });
  return {
    post,
    navigatePrivileged,
    openView,
    startRecording,
    reads,
    messages,
    recoveries,
    guestTracked,
  };
}

const ownerBearerReadsOf = (reads: { bearer: string; sessionId: string }[]) =>
  reads.filter(
    (read) =>
      read.sessionId === OWNER_SESSION &&
      read.bearer === `Bearer ${bearerFor[OWNER_SESSION]}`,
  );

describe('Session-local control ingress: a guest Session without a resolved requester context', () => {
  it('refuses a withdrawn guest typed instead of saving a recording aimed at an owner Session as the owner', async () => {
    const fixture = await createFixture('withdrawn');
    const { profileId } = await fixture.openView(GUEST_SESSION);
    const aimed = await fixture.startRecording(
      GUEST_SESSION,
      profileId,
      'aimed',
      OWNER_SESSION,
    );
    expect(aimed, JSON.stringify(aimed)).toEqual({
      ok: false,
      errorCode: 'requester_session_not_current',
      error: 'requester_session_not_current',
    });
    // Nothing was read or written as the owner on the guest's behalf.
    expect(ownerBearerReadsOf(fixture.reads)).toEqual([]);
    expect(fixture.messages).toEqual([]);
  });

  it('refuses a withdrawn guest typed on a Manage-only Browser action instead of admitting it as the Machine owner', async () => {
    const fixture = await createFixture('withdrawn');
    await fixture.openView(GUEST_SESSION);
    const manageOnly = await fixture.navigatePrivileged(GUEST_SESSION);
    expect(manageOnly, JSON.stringify(manageOnly)).toEqual({
      ok: false,
      errorCode: 'requester_session_not_current',
      error: 'requester_session_not_current',
    });
  });

  it('resolves a guest who still has access on the first Action, then decides as that guest', async () => {
    const fixture = await createFixture('has_access');
    const { opened, profileId } = await fixture.openView(GUEST_SESSION);
    expect(opened, JSON.stringify(opened)).toMatchObject({ status: 'dispatched' });
    // The first Action resolved and published the guest's context; later Actions reuse it.
    expect(fixture.recoveries).toEqual([GUEST_SESSION]);
    expect(
      fixture.guestTracked.requesterSessionRuntimeContext?.bootstrap.attribution
        .accountId,
    ).toBe('guest');
    const aimed = await fixture.startRecording(
      GUEST_SESSION,
      profileId,
      'aimed',
      OWNER_SESSION,
    );
    expect(aimed, JSON.stringify(aimed)).toMatchObject({
        status: 'unavailable',
        reason: { code: 'recording_session_unavailable' },
    });
    expect(ownerBearerReadsOf(fixture.reads)).toEqual([]);
    expect(
      await fixture.navigatePrivileged(GUEST_SESSION),
    ).toEqual({
      ok: false,
      errorCode: 'access_denied',
      error: 'access_denied',
    });
    const own = await fixture.startRecording(
      GUEST_SESSION,
      profileId,
      'own',
      GUEST_SESSION,
    );
    expect(own, JSON.stringify(own)).toMatchObject({ status: 'started' });
    expect(fixture.recoveries).toEqual([GUEST_SESSION]);
    expect(fixture.messages).toEqual([]);
  });

  it("keeps the Machine owner's own Session on the owner path without a requester recovery", async () => {
    const fixture = await createFixture('withdrawn');
    const { opened, profileId } = await fixture.openView(OWNER_SESSION);
    expect(opened, JSON.stringify(opened)).toMatchObject({ status: 'dispatched' });
    const own = await fixture.startRecording(
      OWNER_SESSION,
      profileId,
      'owner',
      OWNER_SESSION,
    );
    expect(own, JSON.stringify(own)).toMatchObject({ status: 'started' });
    expect(ownerBearerReadsOf(fixture.reads).length).toBeGreaterThan(0);
    expect(fixture.recoveries).toEqual([]);
  });
});
