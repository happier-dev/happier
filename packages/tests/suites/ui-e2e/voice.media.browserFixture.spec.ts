import { expect, test, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';

let server: Server | null = null;
let origin = '';

async function acquireMicrophone(page: Page, audio: boolean | MediaTrackConstraints) {
  await page.goto(origin);
  return page.evaluate(async (audioConstraints) => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    const [track] = stream.getAudioTracks();
    const snapshot = {
      secureContext: window.isSecureContext,
      trackCount: stream.getAudioTracks().length,
      readyState: track?.readyState ?? null,
      settings: track?.getSettings() ?? null,
    };
    for (const mediaTrack of stream.getTracks()) mediaTrack.stop();
    return snapshot;
  }, audio);
}

test.describe('voice browser fixture contract', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async () => {
    const activeServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Voice fixture contract</title>');
    });
    server = activeServer;
    await new Promise<void>((resolve, reject) => {
      activeServer.once('error', reject);
      activeServer.listen(0, '127.0.0.1', () => resolve());
    });
    const address = activeServer.address();
    if (!address || typeof address === 'string') throw new Error('voice_fixture_server_address_missing');
    origin = `http://127.0.0.1:${address.port}`;
  });

  test.afterAll(async () => {
    const activeServer = server;
    server = null;
    if (!activeServer) return;
    await new Promise<void>((resolve, reject) => {
      activeServer.close((error) => error ? reject(error) : resolve());
    });
  });

  test('the browser process receives the generated microphone launch contract', async ({ page }, testInfo) => {
    const fixturePath = testInfo.project.metadata.voiceQaFixturePath;
    expect(typeof fixturePath).toBe('string');
    const session = await page.context().newCDPSession(page);
    const result = await session.send('Browser.getBrowserCommandLine');
    expect(result.arguments).toContain('--use-fake-ui-for-media-stream');
    expect(result.arguments).toContain('--use-fake-device-for-media-stream');
    expect(result.arguments).toContain(`--use-file-for-fake-audio-capture=${fixturePath}`);
  });

  test('the configured generated WAV is a valid Chromium microphone source', async ({ page }) => {
    const result = await acquireMicrophone(page, true);

    expect(result).toMatchObject({
      secureContext: true,
      trackCount: 1,
      readyState: 'live',
    });
  });

  test('the generated microphone satisfies production processing constraints', async ({ page }) => {
    const result = await acquireMicrophone(page, {
      echoCancellation: true,
      noiseSuppression: true,
    });

    expect(result).toMatchObject({
      secureContext: true,
      trackCount: 1,
      readyState: 'live',
    });
  });
});
