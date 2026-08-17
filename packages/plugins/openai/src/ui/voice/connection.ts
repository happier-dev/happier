const MAX_PROVIDER_SDP_RESPONSE_BYTES = 64 * 1024;
export const OPENAI_CLIENT_AUTH_EXPIRY_SAFETY_WINDOW_MS = 1_000;

function providerError(): Error {
  return Object.assign(new Error('provider_response_invalid'), {
    code: 'provider_response_invalid',
  });
}

function authExpiredError(): Error {
  return Object.assign(new Error('voice_auth_expired'), {
    code: 'voice_auth_expired',
  });
}

async function readBoundedSdp(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const declaredLength = response.headers.get('content-length');
    if (
      declaredLength !== null
      && (!/^\d+$/u.test(declaredLength)
        || Number(declaredLength) > MAX_PROVIDER_SDP_RESPONSE_BYTES)
    ) {
      throw providerError();
    }
    const sdp = await response.text();
    if (
      !sdp
      || new TextEncoder().encode(sdp).byteLength > MAX_PROVIDER_SDP_RESPONSE_BYTES
    ) {
      throw providerError();
    }
    return sdp;
  }
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let byteLength = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    byteLength += next.value.byteLength;
    if (byteLength > MAX_PROVIDER_SDP_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw providerError();
    }
    parts.push(decoder.decode(next.value, { stream: true }));
  }
  parts.push(decoder.decode());
  const sdp = parts.join('');
  if (!sdp) throw providerError();
  return sdp;
}

export function createOpenAiWebRtcSignaling(input: Readonly<{
  ephemeralToken: string;
  expiresAtMs: number;
  fetch?: typeof globalThis.fetch;
  callsUrl?: string;
}>) {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const callsUrl = input.callsUrl ?? 'https://api.openai.com/v1/realtime/calls';

  return Object.freeze({
    async exchangeOffer(request: Readonly<{
      offerSdp: string;
      signal: AbortSignal;
    }>): Promise<Readonly<{ answerSdp: string }>> {
      if (
        input.expiresAtMs
        <= Date.now() + OPENAI_CLIENT_AUTH_EXPIRY_SAFETY_WINDOW_MS
      ) {
        throw authExpiredError();
      }
      const response = await fetchImpl(callsUrl, {
        method: 'POST',
        body: request.offerSdp,
        headers: {
          Authorization: `Bearer ${input.ephemeralToken}`,
          'Content-Type': 'application/sdp',
        },
        redirect: 'error',
        signal: request.signal,
      });
      if (!response.ok || response.redirected) throw providerError();
      return Object.freeze({
        answerSdp: await readBoundedSdp(response),
      });
    },
  });
}
