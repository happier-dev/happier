import { describe, expect, it, vi } from 'vitest';

import { createOpenAiWebRtcSignaling } from './connection.js';

describe('OpenAI WebRTC signaling leaf', () => {
  it('exchanges the host-owned offer through public OpenAI Realtime auth', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.openai.com/v1/realtime/calls');
      expect(init).toMatchObject({
        method: 'POST',
        body: 'offer-sdp',
        redirect: 'error',
        headers: {
          Authorization: 'Bearer ek_short',
          'Content-Type': 'application/sdp',
        },
      });
      return new Response('answer-sdp', { status: 201 });
    });
    const signaling = createOpenAiWebRtcSignaling({
      ephemeralToken: 'ek_short',
      expiresAtMs: Date.now() + 60_000,
      fetch,
    });

    await expect(signaling.exchangeOffer({
      offerSdp: 'offer-sdp',
      signal: new AbortController().signal,
    })).resolves.toEqual({ answerSdp: 'answer-sdp' });
  });

  it('bounds the provider response stream before returning it to the host owner', async () => {
    const cancel = vi.fn(async () => undefined);
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(40 * 1024).fill(120) })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(40 * 1024).fill(120) });
    const signaling = createOpenAiWebRtcSignaling({
      ephemeralToken: 'ek_short',
      expiresAtMs: Date.now() + 60_000,
      fetch: vi.fn(async () => ({
        ok: true,
        redirected: false,
        body: { getReader: () => ({ read, cancel }) },
      } as unknown as Response)),
    });

    await expect(signaling.exchangeOffer({
      offerSdp: 'offer-sdp',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('reads a bounded React Native response when streaming response bodies are unavailable', async () => {
    const signaling = createOpenAiWebRtcSignaling({
      ephemeralToken: 'ek_short',
      expiresAtMs: Date.now() + 60_000,
      fetch: vi.fn(async () => ({
        ok: true,
        redirected: false,
        headers: { get: () => null },
        body: null,
        text: vi.fn(async () => 'native-answer-sdp'),
      } as unknown as Response)),
    });

    await expect(signaling.exchangeOffer({
      offerSdp: 'offer-sdp',
      signal: new AbortController().signal,
    })).resolves.toEqual({ answerSdp: 'native-answer-sdp' });
  });

  it('rejects an oversized React Native response without returning it to the host', async () => {
    const signaling = createOpenAiWebRtcSignaling({
      ephemeralToken: 'ek_short',
      expiresAtMs: Date.now() + 60_000,
      fetch: vi.fn(async () => ({
        ok: true,
        redirected: false,
        headers: { get: () => null },
        body: null,
        text: vi.fn(async () => 'x'.repeat(64 * 1024 + 1)),
      } as unknown as Response)),
    });

    await expect(signaling.exchangeOffer({
      offerSdp: 'offer-sdp',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'provider_response_invalid' });
  });

  it('fails typed before provider signaling when admitted auth expires before offer exchange', async () => {
    const now = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetch = vi.fn(async () => new Response('answer-sdp', { status: 201 }));
    const signaling = createOpenAiWebRtcSignaling({
      ephemeralToken: 'ek_expiring',
      expiresAtMs: now + 60_000,
      fetch,
    });

    nowSpy.mockReturnValue(now + 59_500);
    await expect(signaling.exchangeOffer({
      offerSdp: 'offer-created-after-delay',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'voice_auth_expired' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
