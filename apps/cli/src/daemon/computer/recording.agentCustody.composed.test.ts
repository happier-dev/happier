import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  ExternalActionExecutionAuthorizationV1Schema,
} from '@happier-dev/protocol';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { projectRequesterAccountActionAuthorization } from '@/daemon/sessionEncryption/requesterSessionCredentials';
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

const DAEMON_TOKEN = 'owner-daemon';

/**
 * An Agent's Action reaches the recorder with the Session issuer's projected custody
 * (sessionActionOrigin), not original Account ingress. The recording must persist into
 * that requester's own Session with the requester's bearer, never the daemon's.
 */
async function recordAsAgent(
  input: Readonly<{ account: 'owner' | 'guest'; sessionReadable?: boolean }>,
) {
  const root = await mkdtemp(join(tmpdir(), 'computer-agent-custody-'));
  const sessionId = `${input.account}-agent-session`;
  const requesterToken = `${input.account}-session-token`;
  const metadata = createTestMetadata({ path: root, machineId: 'machine' });
  const session = {
    ...createSessionNotificationContextFixture(sessionId),
    encryptionMode: 'plain',
    metadataLayoutVersion: 1,
    metadata: JSON.stringify({ v: 1 }),
    ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({
      v: 1,
      workspace: metadata,
    }),
  };
  const bearers: string[] = [];
  const messages: { bearer: string; body: Record<string, unknown> }[] = [];
  // Home HTTP is the genuine boundary: only the requester's bearer can read or write its Session.
  const server = createServer(async (request, response) => {
    const bearer = request.headers.authorization ?? '';
    bearers.push(bearer);
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.startsWith('/v2/sessions/')) {
      if (
        input.sessionReadable === false ||
        bearer !== `Bearer ${requesterToken}` ||
        !request.url.startsWith(`/v2/sessions/${sessionId}`)
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
        messages.push({ bearer, body });
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
      } else response.end(JSON.stringify({ session }));
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
    sessionId,
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
  // The ffmpeg process is the replaced boundary; capture, lifecycle and persistence stay real.
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
  const recording = createComputerRecording({
    machineId: 'machine',
    registry,
    options: {
      workingDirectory: root,
      encoderFactory,
      ...createRecordingSessionMediaHost({
        credentials: { token: DAEMON_TOKEN, encryption: null },
        serverHttpBaseUrl,
        machineId: 'machine',
        currentMachineHost: metadata.host,
        currentMachineHomeDir: metadata.homeDir,
        mutationCustody: {
          stageTranscriptMessage: async () => {
            throw new Error(
              'daemon Account custody must not stage requester media',
            );
          },
        },
        title: 'Computer recording',
      }),
    },
  });

  // The Session issuer's real projection of an Agent-origin Action on this Machine.
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({
    v: 1,
    token: `${input.account}-agent-action`,
    binding: {
      accountId: input.account,
      custodianAccountId: 'owner',
      authentication: { kind: 'account', tokenEpoch: 0 },
      serverIdentityId: 'stable-home',
      machineId: 'machine',
      installationId: 'installation',
      accountEncryptionMode: 'plain',
      actionId: 'computer.recording.start',
      requestId: 'request',
      requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'machine' },
      sessionActionSource: {
        machineId: 'machine',
        installationId: 'installation',
      },
      sessionActionOrigin: {
        v: 1,
        caller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
        sourceTurnId: 'turn',
        callerPermissionMode: null,
        requestId: 'request',
      },
    },
  });
  const projected = await projectRequesterAccountActionAuthorization({
    authorization,
    serverIdentityId: 'stable-home',
    bootstrap: {
      credentials: { token: requesterToken, encryption: null },
      serverHttpBaseUrl,
      isCurrent: async () => true,
      attribution: {
        serverId: 'home-profile',
        accountId: input.account,
        machineId: 'machine',
        installationId: 'installation',
      },
      getBoundSessionId: () => sessionId,
    },
  });
  if (!projected)
    throw new Error('Session issuer custody projection refused the fixture');
  try {
    const started = await recording.start(
      {
        machineId: 'machine',
        sourceId: source.sourceId,
        mediaTarget: { sessionId, messageLocalId: 'agent-recording' },
        retentionClass: 'preSend',
      },
      source,
      {
        externalActionExecutionAuthorization: projected,
        defaultSessionId: sessionId,
      },
    );
    if (!('recording' in started))
      throw new Error(`Start refused: ${JSON.stringify(started)}`);
    await new Promise<void>((ready) => setTimeout(ready, 50));
    const stopped = await recording.service.stopRecording({
      recordingId: started.recording.recordingId,
    });
    const files = (await readdir(root, { recursive: true })).map(String);
    return {
      stopped,
      bearers,
      messages,
      files,
      frames: encodedFrames,
      requesterToken,
    };
  } finally {
    await recording.closeSource(source.sourceId);
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await rm(root, { recursive: true, force: true });
  }
}

it.each(['owner', 'guest'] as const)(
  'retains a %s Agent recording in that requester’s own Session under its admitted custody',
  async (account) => {
    const result = await recordAsAgent({ account });
    expect(result.stopped).toMatchObject({
      status: 'finalized',
      recording: {
        status: 'finalized',
        mediaRef: { refKind: 'sessionMedia', mediaKind: 'video' },
      },
    });
    expect(result.frames).toBeGreaterThan(0);
    expect(result.files.some((file) => file.endsWith('.webm'))).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.body.localId).toBe('agent-recording');
    // Every Home read and the transcript write used the requester's custody, never the daemon Account.
    expect(result.bearers.length).toBeGreaterThan(0);
    expect(
      result.bearers.every(
        (bearer) => bearer === `Bearer ${result.requesterToken}`,
      ),
    ).toBe(true);
  },
);

it('names a capture that stopped cleanly but could not be saved as a media persistence failure, not a capture failure', async () => {
  const result = await recordAsAgent({
    account: 'guest',
    sessionReadable: false,
  });
  expect(result.frames).toBeGreaterThan(0);
  expect(result.stopped).toMatchObject({
    status: 'failed',
    reason: 'media_persistence_failed',
    recording: { status: 'failed', outcomeReason: 'media_persistence_failed' },
  });
  expect(
    result.bearers.every(
      (bearer) => bearer === `Bearer ${result.requesterToken}`,
    ),
  ).toBe(true);
});
