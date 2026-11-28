import { createServer } from 'node:http';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  type BrowserRecordingSessionV1,
} from '@happier-dev/protocol';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { runFilesystemEffectInternal } from '@/rpc/handlers/fileSystem/filesystemEffectInternal';
import {
  createFilesystemEffectChannel,
  initializeFilesystemEffectChannel,
} from '@/rpc/handlers/fileSystem/filesystemEffectChannel';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { createRequesterSessionAccountContextCustody } from '@/daemon/sessionEncryption/requesterSessionAccountContextCustody';
import type { RequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import type { TrackedSession } from '@/daemon/types';
import {
  createRecordingSessionMediaHost,
  selectRecordingMediaPlacement,
  type RecordingOperationContext,
} from './sessionMediaHost';
import { createBrowserRecordingSessionMediaWriter } from './sessionMediaWriter';

const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03]);
const attribution = {
  serverId: 'home',
  accountId: 'member',
  machineId: 'machine',
  installationId: 'installation',
};

// A Separate-users Machine (linuxUsersV1): the owner `owner` hosts the guest `member`'s own Session.
// Real owners: Session read, requester custody, filesystem-effect admission and identity selection,
// the member's filesystem-effect process (byte staging, media persistence, delete) and the writer.
// Only the native process pipes are in-process; kernel UID separation of that process is the
// native launcher's contract (agentIsolation.real.integration.test.ts).
async function withMemberSessionFixture(
  run: (
    fixture: Readonly<{
      root: string;
      artifactPath: string;
      sessionId: string;
      channels: string[][];
      host: ReturnType<typeof createRecordingSessionMediaHost>;
      context(actorAccountId: string): RecordingOperationContext;
    }>,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'recording-member-workspace-'));
  const daemonTemp = await mkdtemp(join(tmpdir(), 'recording-daemon-capture-'));
  const sessionId = 'member-recording-session';
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
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.startsWith('/v2/sessions/')) {
      if (
        request.headers.authorization !== 'Bearer member-token' ||
        !request.url.startsWith(`/v2/sessions/${sessionId}`)
      ) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      response.end(JSON.stringify({ session }));
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
  const serverBaseUrl = `http://127.0.0.1:${address.port}`;
  const sessionAccounts = createRequesterSessionAccountContextCustody({
    trackedSessions: new Map([
      [
        'member',
        {
          happySessionId: sessionId,
          requesterWorkAttributionV1: attribution,
        } as unknown as TrackedSession,
      ],
    ]),
    serverId: 'home',
    machineId: 'machine',
    externalActionAccountId: 'owner',
    isRetired: () => false,
    // test-policy-boundary: the retained Session-birth store opens sealed on-disk custody.
    resolveRequesterSessionRuntimeContext: async (id) =>
      id !== sessionId
        ? null
        : ({
            bootstrap: {
              attribution,
              serverHttpBaseUrl: serverBaseUrl,
              accountEncryptionMode: 'plain',
              credentials: { token: 'member-token', encryption: null },
              getBoundSessionId: () => sessionId,
              isCurrent: async () => true,
            },
          } as unknown as RequesterSessionRuntimeContext),
    releaseRequesterSessionRuntimeContext: async () => {},
  });
  const admission = createFilesystemEffectAdmission({
    resolveHomeServerIdentityId: async () => 'home',
    resolveHostIdentity: async () => ({
      machineId: 'machine',
      installationId: 'installation',
      custodianAccountId: 'owner',
    }),
    readAgentIsolation: () =>
      ({ enabled: true, memberProvisioning: 'linuxUsersV1' }) as never,
  });
  const channels: string[][] = [];
  const host = createRecordingSessionMediaHost({
    credentials: { token: 'owner-token', encryption: null },
    serverHttpBaseUrl: serverBaseUrl,
    machineId: 'machine',
    currentMachineHost: metadata.host,
    currentMachineHomeDir: metadata.homeDir,
    mutationCustody: { stageTranscriptMessage: async () => {} },
    sessionAccounts,
    title: 'Browser recording',
    resolveMediaPlacement: (context, workingDirectory) =>
      selectRecordingMediaPlacement({
        admission,
        context,
        workingDirectory,
        openNative: async (identity, configuration) => {
          expect(identity).toMatchObject({
            kind: 'isolated',
            separationRequired: true,
            requester: { accountId: 'member' },
          });
          const requests: string[] = [];
          channels.push(requests);
          const input = new PassThrough();
          const output = new PassThrough();
          const running = runFilesystemEffectInternal(input, output);
          const channel = createFilesystemEffectChannel({
            input,
            output,
            dispose: async () => {
              await running;
            },
          });
          await initializeFilesystemEffectChannel(channel, configuration);
          return {
            ...channel,
            request: async (request: unknown) => {
              requests.push(String((request as { kind?: unknown }).kind));
              return await channel.request(request);
            },
          };
        },
      }),
  });
  const artifactPath = join(daemonTemp, 'capture.webm');
  await writeFile(artifactPath, webm, { mode: 0o600 });
  try {
    await runWithServerHttpBaseUrl(serverBaseUrl, () =>
      run({
        root,
        artifactPath,
        sessionId,
        channels,
        host,
        context: (actorAccountId) =>
          ({
            authority: 'present_user',
            verifyMachineAdmissionCurrent: async () => {},
            machineAdmission: {
              actorAccountId,
              custodianAccountId: 'owner',
              role: actorAccountId === 'owner' ? 'manage' : 'use',
              machineId: 'machine',
              installationId: 'installation',
              encryptionMode: 'plain',
            },
          }) as unknown as RpcActionExecutorContext,
      }),
    );
  } finally {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await rm(root, { recursive: true, force: true });
    await rm(daemonTemp, { recursive: true, force: true });
  }
}

function writerFor(
  fixture: Parameters<Parameters<typeof withMemberSessionFixture>[0]>[0],
  attach: boolean,
) {
  return createBrowserRecordingSessionMediaWriter({
    workingDirectory: tmpdir(),
    pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
    resolveSessionMediaTarget: () => ({
      sessionId: fixture.sessionId,
      messageLocalId: 'recording-message',
    }),
    admitSave: (target, context) => fixture.host.admitSave(target, context),
    resolveWorkingDirectory: (target, context) =>
      fixture.host.resolveWorkingDirectory(target, context),
    ...(attach ? { commitAttachment: async () => {} } : {}),
  });
}

const recording = {
  recordingId: 'recording',
  startedAtMs: 1,
  stoppedAtMs: 2,
} as unknown as BrowserRecordingSessionV1;
const artifact = (path: string) => ({
  durationMs: 1,
  byteSize: webm.length,
  frameCount: 1,
  fps: 1,
  mimeType: 'video/webm',
  source: {
    kind: 'local-file' as const,
    path,
    mimeType: 'video/webm',
    fileNameHint: 'recording.webm',
  },
});

async function findVideo(root: string) {
  const files = await readdir(root, { recursive: true });
  const video = files.map(String).find((file) => file.endsWith('.webm'));
  return video ? join(root, video) : undefined;
}

it('saves a Separate-users guest recording into its own Session as the guest, and discards it as the guest', async () => {
  await withMemberSessionFixture(async (fixture) => {
    const writer = writerFor(fixture, true);
    const admitted = await writer.admitRecording!({
      recording,
      context: fixture.context('member'),
    });
    expect(admitted.ok, admitted.ok ? undefined : admitted.reason.code).toBe(
      true,
    );
    if (!admitted.ok) return;
    const mediaRef = await writer.persistRecording({
      recording,
      artifact: artifact(fixture.artifactPath),
      captureStopped: true,
      context: admitted.context,
    });
    expect(mediaRef).toMatchObject({
      refKind: 'sessionMedia',
      mediaKind: 'video',
      sizeBytes: webm.length,
    });
    // One requester-owned operation staged the daemon's captured bytes and persisted them there.
    expect(fixture.channels).toEqual([
      [
        'session.media.prepare',
        'upload.open',
        'upload.chunk',
        'upload.finalize',
        'session.media.persist',
      ],
    ]);
    const video = await findVideo(fixture.root);
    expect(
      video?.startsWith(
        join(
          fixture.root,
          '.happier',
          'uploads',
          'artifacts',
          fixture.sessionId,
        ),
      ),
    ).toBe(true);
    expect(await readFile(video!)).toEqual(webm);
    expect((await stat(video!)).mode & 0o777).toBe(0o600);
    await admitted.release();

    // An unattached draft is removed by the guest's own filesystem owner.
    const unattached = writerFor(fixture, false);
    const draft = await unattached.admitRecording!({
      recording,
      context: fixture.context('member'),
    });
    if (!draft.ok) throw new Error(draft.reason.code);
    const draftRef = await unattached.persistRecording({
      recording,
      artifact: artifact(fixture.artifactPath),
      captureStopped: true,
      context: draft.context,
    });
    await unattached.discardRecording({
      recording: {
        ...recording,
        mediaRef: draftRef,
      } as BrowserRecordingSessionV1,
      reason: 'user_discarded',
    });
    expect(fixture.channels.at(-1)).toEqual(['action']);
    expect(await findVideo(fixture.root)).toBeUndefined();
    await draft.release();
  });
});

it('refuses another Account’s save before any capture or member operation', async () => {
  await withMemberSessionFixture(async (fixture) => {
    const admitted = await writerFor(fixture, true).admitRecording!({
      recording,
      context: fixture.context('other-member'),
    });
    expect(admitted).toEqual({
      ok: false,
      reason: {
        code: 'recording_session_not_owned',
        message: expect.any(String),
      },
    });
    expect(fixture.channels).toEqual([]);
  });
});
