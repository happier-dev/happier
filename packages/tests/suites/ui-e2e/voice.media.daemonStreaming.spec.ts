import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import {
  observeVoiceRelaySocketTraffic,
  prepareVoiceBrowserQaPage,
  resolveVoiceBrowserQaBeforeAllTimeoutMs,
  startVoiceBrowserQaStack,
  type VoiceBrowserQaStack,
} from '../../src/testkit/uiE2e/voiceBrowserQaHarness';
import type { VoiceBrowserQaRouteProfile } from '../../src/testkit/uiE2e/voiceBrowserQaRouteProfile';
import { resolveVoiceBrowserTranscriptExpectation } from '../../src/testkit/uiE2e/voiceBrowserTranscriptExpectation';
import { readKnownVoiceFixtureByPath } from '../../src/testkit/voice/voiceFixture';

const ZIPFORMER_PACK_ID = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
const ZIPFORMER_MANIFEST_URL =
  `https://github.com/happier-dev/happier-assets/releases/download/model-packs/${ZIPFORMER_PACK_ID}__manifest.json`;
const run = createRunDirs({ runLabel: 'ui-e2e-voice-daemon-streaming' });
const requestedRouteProfile = process.env.HAPPIER_E2E_VOICE_ROUTE_PROFILE;
const routeProfiles: readonly VoiceBrowserQaRouteProfile[] =
  requestedRouteProfile === 'direct' || requestedRouteProfile === 'relay'
    ? [requestedRouteProfile]
    : ['direct', 'relay'];

for (const routeProfile of routeProfiles) {
  test.describe(`voice G3.6: generated microphone to daemon streaming STT (${routeProfile})`, () => {
    test.describe.configure({ mode: 'serial' });
    const suiteDir = run.testDir(`voice-daemon-streaming-${routeProfile}`);
    let stack: VoiceBrowserQaStack | null = null;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(Math.max(resolveVoiceBrowserQaBeforeAllTimeoutMs(), 600_000));
      void browser;
      await mkdir(suiteDir, { recursive: true });
      stack = await startVoiceBrowserQaStack({
        suiteDir,
        storageScope: `e2e-voice-daemon-streaming-${routeProfile}-${run.runId}`,
        routeProfile,
        accountMode: 'data_key',
        daemonSttModel: {
          packId: ZIPFORMER_PACK_ID,
          manifestUrl: ZIPFORMER_MANIFEST_URL,
        },
      });
    });

    test.afterAll(async () => {
      test.setTimeout(180_000);
      await stack?.stopRunnableSessions().catch(() => {});
      await stack?.ui.stop().catch(() => {});
      await stack?.daemon.stop().catch(() => {});
      await stack?.server.stop().catch(() => {});
    });

    test('streams production microphone PCM over the selected binary route and cleans up after finish', async ({ page }, testInfo) => {
      test.setTimeout(600_000);
      if (!stack) throw new Error('voice daemon streaming harness missing');
      const configuredFixturePath = testInfo.project.metadata.voiceQaFixturePath;
      if (typeof configuredFixturePath !== 'string' || !isAbsolute(configuredFixturePath)) {
        throw new Error('voice_q3_6_fixture_path_missing');
      }
      const fixturePath = configuredFixturePath;
      const knownFixture = await readKnownVoiceFixtureByPath(fixturePath);
      const transcriptExpectation = resolveVoiceBrowserTranscriptExpectation({
        fixturePath,
        metadata: knownFixture?.metadata ?? null,
        explicitSignal: process.env.HAPPIER_E2E_VOICE_EXPECTED_TRANSCRIPT_SIGNAL,
      });
      const captureDurationMs = knownFixture
        ? knownFixture.metadata.durationMs + 1_000
        : 8_000;
      await page.setViewportSize({ width: 1440, height: 900 });
      const peerRequestStages: Array<Readonly<{
        method: string;
        origin: string;
        pathname: string;
        status: number | null;
        failure: string | null;
        grantRequest: Readonly<{
          v: number | null;
          flowKind: string | null;
          routeKind: string | null;
          scopeKind: string | null;
        }> | null;
        grantResponse: Readonly<{
          ok: boolean | null;
          reasonCode: string | null;
          grantVersion: number | null;
          flowKind: string | null;
          scopeKind: string | null;
          proofKind: string | null;
        }> | null;
      }>> = [];
      const isPeerRequest = (rawUrl: string) => {
        const pathname = new URL(rawUrl).pathname;
        return pathname === '/v1/machines/peer/mediation/route-grants'
          || pathname.startsWith('/peer-mediation/');
      };
      page.on('response', async (response) => {
        if (!isPeerRequest(response.url())) return;
        const url = new URL(response.url());
        const requestBody = url.pathname === '/v1/machines/peer/mediation/route-grants'
          ? response.request().postDataJSON() as Record<string, unknown> | null
          : null;
        const requestScope = requestBody?.scope && typeof requestBody.scope === 'object'
          ? requestBody.scope as Record<string, unknown>
          : null;
        const responseBody = url.pathname === '/v1/machines/peer/mediation/route-grants'
          ? await response.json().catch(() => null) as Record<string, unknown> | null
          : null;
        const grant = responseBody?.grant && typeof responseBody.grant === 'object'
          ? responseBody.grant as Record<string, unknown>
          : null;
        const grantPayload = grant?.payload && typeof grant.payload === 'object'
          ? grant.payload as Record<string, unknown>
          : null;
        const grantScope = grantPayload?.scope && typeof grantPayload.scope === 'object'
          ? grantPayload.scope as Record<string, unknown>
          : null;
        peerRequestStages.push({
          method: response.request().method(),
          origin: url.origin,
          pathname: url.pathname,
          status: response.status(),
          failure: null,
          grantRequest: requestBody ? {
            v: typeof requestBody.v === 'number' ? requestBody.v : null,
            flowKind: typeof requestBody.flowKind === 'string' ? requestBody.flowKind : null,
            routeKind: typeof requestBody.routeKind === 'string' ? requestBody.routeKind : null,
            scopeKind: typeof requestScope?.kind === 'string' ? requestScope.kind : null,
          } : null,
          grantResponse: responseBody ? {
            ok: typeof responseBody.ok === 'boolean' ? responseBody.ok : null,
            reasonCode: typeof responseBody.reasonCode === 'string' ? responseBody.reasonCode : null,
            grantVersion: typeof grantPayload?.v === 'number' ? grantPayload.v : null,
            flowKind: typeof grantPayload?.flowKind === 'string' ? grantPayload.flowKind : null,
            scopeKind: typeof grantScope?.kind === 'string' ? grantScope.kind : null,
            proofKind: typeof grantPayload?.proofKind === 'string' ? grantPayload.proofKind : null,
          } : null,
        });
      });
      page.on('requestfailed', (request) => {
        if (!isPeerRequest(request.url())) return;
        const url = new URL(request.url());
        peerRequestStages.push({
          method: request.method(),
          origin: url.origin,
          pathname: url.pathname,
          status: null,
          failure: request.failure()?.errorText ?? 'request_failed',
          grantRequest: null,
          grantResponse: null,
        });
      });
      const relayTraffic = observeVoiceRelaySocketTraffic(page);
      const { sessionId } = await prepareVoiceBrowserQaPage({
        page,
        stack,
        daemonSttModelPackId: ZIPFORMER_PACK_ID,
        routeQuery: { voiceQaMode: 'media' },
      });
      const mediaSnapshot = page.getByTestId('voiceQa.media.snapshot');
      const transportSnapshot = page.getByTestId('voiceQa.daemonSpeechTransport.snapshot');
      const readMedia = async () => JSON.parse((await mediaSnapshot.textContent()) ?? '{}') as Record<string, unknown>;
      const readTransport = async () => JSON.parse((await transportSnapshot.textContent()) ?? '{}') as Record<string, unknown>;
      const readStartState = async () => {
        const [media, transport] = await Promise.all([readMedia(), readTransport()]);
        return {
          ...media,
          daemonSpeechStartFailure: transport.lastStartFailure ?? null,
        };
      };
      const runtimeIdentity = () => ({
        serverBaseUrl: stack!.server.baseUrl,
        serverPid: stack!.server.proc.child.pid ?? null,
        uiBaseUrl: stack!.uiBaseUrl,
        uiPid: stack!.ui.proc?.child.pid ?? null,
        daemonPid: stack!.daemon.state.pid,
        daemonStartTime: stack!.daemon.state.startTime ?? null,
        daemonCliVersion: stack!.daemon.state.startedWithCliVersion ?? null,
        daemonHomeDir: stack!.daemon.happyHomeDir,
        machineId: stack!.machineId,
        accountMode: 'data_key',
        modelPackId: stack!.daemonSttModelPackId,
      });
      const preStartReadiness = {
        routeProfile,
        runtimeIdentity: runtimeIdentity(),
        daemonSttReadiness: stack.daemonSttReadiness,
        ui: await readMedia(),
        transport: await readTransport(),
      };
      await testInfo.attach(`voice-g3.6-${routeProfile}-pre-start-readiness.json`, {
        body: Buffer.from(JSON.stringify(preStartReadiness, null, 2)),
        contentType: 'application/json',
      });
      const attachStartFailureDiagnostics = async () => {
        const [media, transport, mediaInstrumentation] = await Promise.all([
          readMedia(),
          readTransport(),
          page.evaluate(() => (
            (window as typeof window & { __happierVoiceMediaQa?: unknown }).__happierVoiceMediaQa
            ?? null
          )),
        ]);
        await Promise.all([
          testInfo.attach(`voice-g3.6-${routeProfile}-start-failure-media.json`, {
            body: Buffer.from(JSON.stringify(media, null, 2)),
            contentType: 'application/json',
          }),
          testInfo.attach(`voice-g3.6-${routeProfile}-start-failure-transport.json`, {
            body: Buffer.from(JSON.stringify(transport, null, 2)),
            contentType: 'application/json',
          }),
          testInfo.attach(`voice-g3.6-${routeProfile}-start-failure-peer-stages.json`, {
            body: Buffer.from(JSON.stringify(peerRequestStages, null, 2)),
            contentType: 'application/json',
          }),
          testInfo.attach(`voice-g3.6-${routeProfile}-start-failure-browser-media.json`, {
            body: Buffer.from(JSON.stringify(mediaInstrumentation, null, 2)),
            contentType: 'application/json',
          }),
          testInfo.attach(`voice-g3.6-${routeProfile}-start-failure-relay-traffic.json`, {
            body: Buffer.from(JSON.stringify(relayTraffic.snapshot(), null, 2)),
            contentType: 'application/json',
          }),
        ]);
        return { media, transport, mediaInstrumentation };
      };

      await page.getByTestId('voiceQa.start').click();
      try {
        await expect.poll(readStartState, { timeout: 120_000 }).toMatchObject({
          status: 'connected',
          mode: 'listening',
          configuredProviderId: 'local_conversation',
          executionMachineId: stack.machineId,
          localSttProvider: 'local_neural',
          localSttModelPackId: ZIPFORMER_PACK_ID,
          daemonSpeechStartFailure: null,
        });
        await expect.poll(readTransport, { timeout: 120_000 }).toMatchObject({
          lastTransport: 'binary_tunnel',
          lastBinaryTunnelReceipt: {
            routeKind: routeProfile === 'direct' ? 'loopback_direct' : 'server_relay',
            frameEncoding: 'binary_frame_v2',
            carrierKind: 'binary_tunnel_frame_v2',
            streamIdentity: {
              machineId: stack.machineId,
              packId: ZIPFORMER_PACK_ID,
              streamId: expect.any(String),
              generation: expect.any(Number),
            },
            localTransport: 'open',
          },
        });
      } catch (error) {
        const { media, transport, mediaInstrumentation } = await attachStartFailureDiagnostics();
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(
          `voice_g3_6_start_failed:${JSON.stringify({
            routeProfile,
            preStartReadiness,
            media,
            transport,
            mediaInstrumentation,
            peerRequestStages,
            relayTraffic: relayTraffic.snapshot(),
          })}`,
          { cause: new Error(cause) },
        );
      }
      await expect.poll(async () => page.evaluate(() => (
        (window as typeof window & { __happierVoiceMediaQa?: { maxInputLevel: number } })
          .__happierVoiceMediaQa?.maxInputLevel ?? 0
      )), { timeout: 60_000 }).toBeGreaterThan(0.005);

      // Let the canonical 20 ms PCM producer deliver the known fixture's full
      // speech+silence timeline before finishing the runtime-owned Voice turn.
      // Unknown custom fixtures retain the existing bounded eight-second window.
      await page.waitForTimeout(captureDurationMs);
      if (routeProfile === 'relay') {
        await expect.poll(relayTraffic.binaryAttachmentCount, { timeout: 60_000 }).toBeGreaterThan(0);
      }
      await page.getByTestId('voiceQa.stop').click();

      await expect.poll(readTransport, { timeout: 180_000 }).toMatchObject({
        lastTransport: 'binary_tunnel',
        jsonRpcCompatibilitySelections: 0,
        lastBinaryTunnelReceipt: {
          routeKind: routeProfile === 'direct' ? 'loopback_direct' : 'server_relay',
          frameEncoding: 'binary_frame_v2',
          relayEvidence: routeProfile === 'direct' ? 'not_applicable' : 'finish_authenticated',
          localTransport: 'closed',
          operation: { kind: 'finish', result: 'ok' },
        },
      });
      if (routeProfile === 'relay') {
        await expect.poll(async () => {
          const snapshot = await readTransport();
          const receipt = snapshot.lastBinaryTunnelReceipt as Record<string, unknown> | undefined;
          return typeof receipt?.maxAuthenticatedAckSeq === 'number'
            ? receipt.maxAuthenticatedAckSeq
            : -1;
        }, { timeout: 60_000 }).toBeGreaterThan(0);
      }
      await expect.poll(async () => page.evaluate(() => {
        const state = (window as typeof window & {
          __happierVoiceMediaQa?: { activeTracks: number; stoppedTracks: number };
        }).__happierVoiceMediaQa;
        return state ? { activeTracks: state.activeTracks, stoppedTracks: state.stoppedTracks } : null;
      }), { timeout: 60_000 }).toMatchObject({ activeTracks: 0 });

      if (routeProfile === 'direct') {
        expect(relayTraffic.snapshot()).toEqual({
          sawRelayEventName: false,
          sawBinaryFrameV2Header: false,
          binaryAttachmentCount: 0,
          binaryAttachmentBytes: 0,
          validTunnelFrameCount: 0,
          invalidTunnelFrameCount: 0,
          voiceEncryptedInstallCount: 0,
          voiceEncryptedDataCount: 0,
          voiceEncryptedFinishCount: 0,
          invalidVoicePayloadCount: 0,
          voicePayloadSha256Digests: [],
          receivedBinaryAttachmentCount: 0,
          receivedBinaryAttachmentBytes: 0,
          receivedValidTunnelFrameCount: 0,
          receivedInvalidTunnelFrameCount: 0,
          receivedVoiceEncryptedInstallCount: 0,
          receivedVoiceEncryptedDataCount: 0,
          receivedVoiceEncryptedFinishCount: 0,
          receivedInvalidVoicePayloadCount: 0,
        });
      } else {
        expect(relayTraffic.sawRelayEventName()).toBe(true);
        expect(relayTraffic.sawBinaryFrameV2Header()).toBe(true);
        expect(relayTraffic.binaryAttachmentBytes()).toBeGreaterThan(0);
        const relaySnapshot = relayTraffic.snapshot();
        expect(relaySnapshot.invalidTunnelFrameCount).toBe(0);
        expect(relaySnapshot.invalidVoicePayloadCount).toBe(0);
        expect(relaySnapshot.voiceEncryptedInstallCount).toBeGreaterThan(0);
        expect(relaySnapshot.voiceEncryptedDataCount).toBeGreaterThan(0);
        expect(relaySnapshot.voiceEncryptedFinishCount).toBeGreaterThan(0);
        expect(relaySnapshot.voicePayloadSha256Digests).toHaveLength(
          relaySnapshot.voiceEncryptedInstallCount
            + relaySnapshot.voiceEncryptedDataCount
            + relaySnapshot.voiceEncryptedFinishCount,
        );
      }

      await testInfo.attach(`voice-g3.6-${routeProfile}-receipt.json`, {
        body: Buffer.from(JSON.stringify({
          routeProfile,
          sessionId,
          runtimeIdentity: runtimeIdentity(),
          daemonSttReadiness: stack.daemonSttReadiness,
          media: await readMedia(),
          transport: await readTransport(),
          relayTraffic: relayTraffic.snapshot(),
        }, null, 2)),
        contentType: 'application/json',
      });

      await page.getByTestId('voiceQa.openConversation').click({ timeout: 30_000 });
      await page.waitForURL((url) => url.pathname === `/session/${sessionId}`, { timeout: 120_000 });
      const transcript = page.getByTestId('transcript-chat-list');
      await expect(transcript).toHaveCount(1, { timeout: 120_000 });
      await expect.poll(async () => transcriptExpectation.matches(
        (await transcript.textContent()) ?? '',
      ), {
        message: `daemon transcript did not contain any configured fixture signal: ${transcriptExpectation.signals.join(', ')}`,
        timeout: 120_000,
      }).toBe(true);
      await testInfo.attach(`voice-g3.6-${routeProfile}-transcript-and-cleanup.json`, {
        body: Buffer.from(JSON.stringify({
          routeProfile,
          sessionId,
          transcriptSignals: transcriptExpectation.signals,
          transcriptMatched: true,
          media: await readMedia(),
          transport: await readTransport(),
          browserMedia: await page.evaluate(() => (
            (window as typeof window & { __happierVoiceMediaQa?: unknown }).__happierVoiceMediaQa
            ?? null
          )),
        }, null, 2)),
        contentType: 'application/json',
      });
    });
  });
}
