import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  sealSessionOwnerMetadataEnvelopeV1,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { encryptStoredSessionPayload, resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createDaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { createRequesterSessionAccountContextCustody } from '../sessionEncryption/requesterSessionAccountContextCustody';
import type { RequesterSessionRuntimeContext } from '../sessionEncryption/requesterSessionCredentials';
import type { TrackedSession } from '../types';
import { createComputerCaptureSource } from './source';
import { createComputerRecording } from './recording';
import {
  native,
  target,
  captureResult,
} from './driver/nativeComputerBoundary.testkit';
import { createMachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';
import { createFfmpegBrowserRecordingStreamFrameEncoderFactory } from '../recording/ffmpegStreamEncoder';
import { createRecordingSessionMediaHost } from '../recording/sessionMediaHost';

afterEach(() => vi.restoreAllMocks());

// Identity shapes from the two #140 web failures on 2026-11-22 (Machine owner kit6, Use guest kit7).
const MACHINE = 'de1bff55-fcb4-43f4-877f-2d00cecc188c';
const OWNER = '2781c197-a801-4fb3-86cb-6c0468bc71e7';
const GUEST = 'faa779b5-966c-47fa-b982-2feb33621af0';
const OTHER_GUEST = '0d4e8f7a-2c1b-4f60-9a3e-5b7c9d1e2f30';
const GUEST_SESSION = 'cmwrnpbsp024h5fmc91p88ly2';
const OWNER_SESSION = 'cmwrnvpig024z5fmc45kgqa5s';
const TOKENS = {
  [OWNER]: 'owner-daemon-bearer',
  [GUEST]: 'guest-session-bearer',
} as const;

type Scenario = Readonly<{
  /** The authenticated personal-RPC caller (Machine RPC admission). */
  caller: string;
  /** The Session the caller names for the save. */
  sessionId: string;
  guestMode?: 'plain' | 'e2ee';
  /** Home stops serving the guest Session after START (Session gone mid-recording). */
  guestSessionLostAfterStart?: boolean;
}>;

/**
 * The person's own Computer recording through the personal Machine RPC context: the real
 * RPC context adapter, recorder, media host, workspace reader/writer and transcript
 * custody execute. Home HTTP (only an Account's own bearer reads its Sessions), the
 * ffmpeg process and the retained Session-birth resolver are the substituted boundaries.
 */
async function recordPersonally(input: Scenario) {
  const root = await mkdtemp(join(tmpdir(), 'computer-guest-rpc-'));
  const metadata = createTestMetadata({ path: root, machineId: MACHINE });
  const guestMode = input.guestMode ?? 'plain';
  const secret = new Uint8Array(32).fill(23);
  const ownerMetadataFor = (mode: 'plain' | 'e2ee') =>
    mode === 'plain'
      ? createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: metadata })
      : sealSessionOwnerMetadataEnvelopeV1({
          material: { type: 'legacy', secret },
          ownerMetadata: { v: 1, workspace: metadata },
          randomBytes: (length) => new Uint8Array(length).fill(5),
        });
  const sessions = {
    [GUEST_SESSION]: { owner: TOKENS[GUEST], mode: guestMode },
    [OWNER_SESSION]: { owner: TOKENS[OWNER], mode: 'plain' as const },
  };
  let guestSessionServed = true;
  const reads: { bearer: string; path: string }[] = [];
  const messages: {
    bearer: string;
    sessionId: string;
    body: Record<string, unknown>;
  }[] = [];
  const modeFor = (bearer: string) =>
    bearer === `Bearer ${TOKENS[GUEST]}` ? guestMode : 'plain';
  const server = createServer(async (request, response) => {
    const bearer = request.headers.authorization ?? '';
    const path = request.url ?? '';
    reads.push({ bearer, path });
    response.setHeader('Content-Type', 'application/json');
    const sessionMatch = /^\/v2\/sessions\/([^/?]+)/.exec(path);
    if (sessionMatch) {
      const sessionId = sessionMatch[1]!;
      const record = sessions[sessionId as keyof typeof sessions];
      const served =
        record &&
        bearer === `Bearer ${record.owner}` &&
        (sessionId !== GUEST_SESSION || guestSessionServed);
      if (!served) {
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
        messages.push({ bearer, sessionId, body });
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
        return;
      }
      const projection = createSessionNotificationContextFixture(sessionId);
      // An encrypted Session's shared metadata is sealed by the real producer with its owner's material.
      const ctx = record.mode === 'e2ee'
        ? resolveSessionEncryptionContextFromCredentials({ token: record.owner, encryption: { type: 'legacy', secret } },
          { ...projection, encryptionMode: 'e2ee' })
        : null;
      if (record.mode === 'e2ee' && !ctx) throw new Error('Encrypted Session fixture material unavailable');
      response.end(
        JSON.stringify({
          session: {
            ...projection,
            encryptionMode: record.mode,
            metadataLayoutVersion: 1,
            metadata: ctx ? encryptStoredSessionPayload({ mode: 'e2ee', ctx, payload: { v: 1 } }) : JSON.stringify({ v: 1 }),
            ownerMetadata: ownerMetadataFor(record.mode),
          },
        }),
      );
    } else if (path.includes('encryption/currentness')) {
      response.end(
        JSON.stringify({
          mode: modeFor(bearer),
          version: 1,
          updatedAt: 0,
          signingKeyFingerprint: null,
          contentKeyFingerprint: null,
        }),
      );
    } else
      response.end(JSON.stringify({ mode: modeFor(bearer), updatedAt: 0 }));
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture did not bind');
  const serverHttpBaseUrl = `http://127.0.0.1:${address.port}`;

  native.call.mockImplementation(async ({ name }) =>
    name === 'get_window_state'
      ? captureResult()
      : name === 'list_windows'
        ? {
            structuredContent: {
              windows: [
                {
                  pid: target.pid,
                  window_id: target.windowId,
                  title: 'Editor',
                },
              ],
            },
          }
        : { structuredContent: { x11: true, xsend_event: true } },
  );
  const registry = createMachineLiveStreamCaptureRegistry();
  const source = createComputerCaptureSource({
    sessionId: input.sessionId,
    target,
    executablePath: '/managed/cua-driver',
  });
  registry.register({
    sourceId: source.sourceId,
    streamFamily: 'screen',
    computer: source,
    adapter: source.adapter,
    capabilities: {
      v: 1,
      sourceId: source.sourceId,
      sourceKind: 'screen',
      supportedCodecs: ['image.frame.v1'],
      inputMode: 'shared',
      sidebands: [],
      health: { status: 'available' },
    },
  });
  let encodedFrames = 0;
  const encoderFactory = createFfmpegBrowserRecordingStreamFrameEncoderFactory({
    workingDirectory: root,
    resolveFfmpegBinaryPath: async () => '/fixture/ffmpeg',
    spawnFfmpeg: (_binary, args) => {
      const child = new EventEmitter();
      const stdin = new Writable({
        write(_chunk, _encoding, callback) {
          encodedFrames++;
          callback();
        },
        final(callback) {
          void writeFile(
            args.at(-1)!,
            Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]),
          ).then(() => {
            callback();
            child.emit('close', 0, null);
          }, callback);
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

  // Machine core's requester custody for the guest's tracked Session, admitted at its spawn.
  const guestAttribution = {
    serverId: 'home-profile',
    accountId: GUEST,
    machineId: MACHINE,
    installationId: 'installation',
  };
  const trackedSessions = new Map([
    [
      'guest',
      {
        happySessionId: GUEST_SESSION,
        requesterWorkAttributionV1: guestAttribution,
      } as unknown as TrackedSession,
    ],
  ]);
  let retainedGuestCustody = 0;
  const sessionAccounts = createRequesterSessionAccountContextCustody({
    trackedSessions,
    serverId: 'home-profile',
    machineId: MACHINE,
    externalActionAccountId: OWNER,
    isRetired: () => false,
    // test-policy-boundary: the retained Session-birth store opens sealed on-disk custody.
    resolveRequesterSessionRuntimeContext: async (sessionId) => {
      if (sessionId !== GUEST_SESSION) return null;
      retainedGuestCustody++;
      return {
        bootstrap: {
          attribution: guestAttribution,
          serverHttpBaseUrl,
          accountEncryptionMode: guestMode,
          credentials: {
            token: TOKENS[GUEST],
            encryption:
              guestMode === 'plain' ? null : { type: 'legacy', secret },
          },
          getBoundSessionId: () => GUEST_SESSION,
          isCurrent: async () => true,
        },
      } as unknown as RequesterSessionRuntimeContext;
    },
    releaseRequesterSessionRuntimeContext: async () => {
      retainedGuestCustody--;
    },
  });
  const ownerCustody = createDaemonSessionMutationCustody({
    credentials: { token: TOKENS[OWNER], encryption: null },
  });
  const recording = createComputerRecording({
    machineId: MACHINE,
    registry,
    options: {
      workingDirectory: root,
      encoderFactory,
      ...createRecordingSessionMediaHost({
        credentials: { token: TOKENS[OWNER], encryption: null },
        serverHttpBaseUrl,
        machineId: MACHINE,
        currentMachineHost: metadata.host,
        currentMachineHomeDir: metadata.homeDir,
        mutationCustody: ownerCustody,
        sessionAccounts,
        title: 'Computer recording',
      }),
    },
  });
  // daemonComputer builds this context from the verified personal RPC (Machine admission only).
  const context = buildActionExecutorContextForRpc({
    defaultSessionId: input.sessionId,
    localActionContext: { surface: 'ui' },
    callerAuthority: 'present_user',
    signal: new AbortController().signal,
    machineAdmission: {
      actorAccountId: input.caller,
      custodianAccountId: OWNER,
      role: input.caller === OWNER ? 'manage' : 'use',
      machineId: MACHINE,
      installationId: '6ca68523-e93e-46e0-8e41-c88f4c86f24f',
      encryptionMode: 'e2ee',
    },
  });
  try {
    return await runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
      const started = await recording.start(
        {
          machineId: MACHINE,
          sourceId: source.sourceId,
          mediaTarget: {
            sessionId: input.sessionId,
            messageLocalId: 'personal-recording',
          },
          retentionClass: 'preSend',
        },
        source,
        context,
      );
      const framesAtStart = encodedFrames;
      if (!('status' in started) || started.status !== 'started') {
        return {
          started,
          stopped: null,
          reads,
          messages,
          framesAtStart,
          frames: encodedFrames,
          files: [] as string[],
          retainedGuestCustody,
        };
      }
      await new Promise<void>((ready) => setTimeout(ready, 50));
      if (input.guestSessionLostAfterStart) guestSessionServed = false;
      const stopped = await recording.service.stopRecording({
        recordingId: started.recording.recordingId,
      });
      await new Promise<void>((ready) => setTimeout(ready, 20));
      const files = (await readdir(root, { recursive: true })).map(String);
      return {
        started,
        stopped,
        reads,
        messages,
        framesAtStart,
        frames: encodedFrames,
        files,
        retainedGuestCustody,
      };
    });
  } finally {
    await recording.closeSource(source.sourceId);
    await ownerCustody.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}

const sessionBearers = (result: Awaited<ReturnType<typeof recordPersonally>>) =>
  new Set(
    result.reads
      .filter((read) => read.path.startsWith('/v2/sessions/'))
      .map((read) => read.bearer),
  );

it.each(['plain', 'e2ee'] as const)(
  'saves a Use guest’s own %s Session recording with that Session’s retained custody',
  async (guestMode) => {
    const result = await recordPersonally({
      caller: GUEST,
      sessionId: GUEST_SESSION,
      guestMode,
    });
    expect(result.stopped).toMatchObject({
      status: 'finalized',
      recording: {
        status: 'finalized',
        mediaRef: { refKind: 'sessionMedia', mediaKind: 'video' },
      },
    });
    expect(result.files.some((file) => file.endsWith('.webm'))).toBe(true);
    // Every Session read and the transcript write used the guest Session's own custody, never the Machine owner's.
    expect(sessionBearers(result)).toEqual(
      new Set([`Bearer ${TOKENS[GUEST]}`]),
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      sessionId: GUEST_SESSION,
      body: { localId: 'personal-recording' },
    });
    // The transcript card is sealed the way that Session's own content is: never plain for an encrypted Session.
    expect((result.messages[0]?.body.content as { t?: string }).t).toBe(
      guestMode === 'plain' ? 'plain' : 'encrypted',
    );
    expect(result.retainedGuestCustody).toBe(0);
  },
);

it('keeps the Machine owner’s own recording on the daemon custody', async () => {
  const result = await recordPersonally({
    caller: OWNER,
    sessionId: OWNER_SESSION,
  });
  expect(result.stopped).toMatchObject({
    status: 'finalized',
    recording: { mediaRef: { mediaKind: 'video' } },
  });
  expect(sessionBearers(result)).toEqual(new Set([`Bearer ${TOKENS[OWNER]}`]));
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0]?.sessionId).toBe(OWNER_SESSION);
});

it.each([
  {
    name: 'the Machine owner naming the guest’s Session',
    caller: OWNER,
    sessionId: GUEST_SESSION,
  },
  {
    name: 'another Use guest naming the guest’s Session',
    caller: OTHER_GUEST,
    sessionId: GUEST_SESSION,
  },
  {
    name: 'a Use guest naming the Machine owner’s Session',
    caller: GUEST,
    sessionId: OWNER_SESSION,
  },
])(
  'refuses $name at START, before any capture or write',
  async ({ caller, sessionId }) => {
    const result = await recordPersonally({ caller, sessionId });
    expect(result.started).toEqual({
      status: 'unavailable',
      reason: {
        code: 'recording_session_not_owned',
        message: expect.any(String),
      },
    });
    expect(result.frames).toBe(0);
    expect(result.messages).toEqual([]);
    expect(result.retainedGuestCustody).toBe(0);
  },
);

it('says a stopped capture was kept in the Session workspace but not attached when the Session is lost after START', async () => {
  const result = await recordPersonally({
    caller: GUEST,
    sessionId: GUEST_SESSION,
    guestSessionLostAfterStart: true,
  });
  expect(result.frames).toBeGreaterThan(0);
  expect(result.stopped).toMatchObject({
    status: 'failed',
    reason: 'media_persistence_failed',
    saveFailure: 'transcript_attach_failed',
    recording: { status: 'failed', outcomeReason: 'media_persistence_failed' },
  });
  expect(result.files.some((file) => file.endsWith('.webm'))).toBe(true);
  expect(result.messages).toEqual([]);
  expect(result.retainedGuestCustody).toBe(0);
});
