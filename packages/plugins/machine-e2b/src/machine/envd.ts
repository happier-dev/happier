import { E2bNativeError } from './nativeFailure.js';
import { decodeBase64 } from '@happier-dev/plugin-sdk/protocol';

export type EnvdSession = Readonly<{ origin: string; token: string }>;
const invalid = () => new E2bNativeError({ code: 'e2b_invalid_response' });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function concatenate(parts: readonly Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

/** envd Process/Start: Connect v1 JSON envelopes, bytes fields are base64. */
export async function executeEnvd(request: typeof fetch, signal: AbortSignal, session: EnvdSession,
  argv: readonly string[], envs?: Readonly<Record<string, string>>, timeoutMs?: number | null,
): Promise<Readonly<{ stdout: Uint8Array; stderr: Uint8Array; exitCode: number }>> {
  signal.throwIfAborted();
  const json = new TextEncoder().encode(JSON.stringify({ process: { cmd: argv[0], args: argv.slice(1), ...(envs ? { envs } : {}) }, stdin: false }));
  const body = new Uint8Array(json.length + 5);
  new DataView(body.buffer).setUint32(1, json.length); body.set(json, 5);
  const response = await request(session.origin + '/process.Process/Start', { method: 'POST', redirect: 'error', signal, body,
    headers: { 'content-type': 'application/connect+json', 'connect-protocol-version': '1',
      'x-access-token': session.token, authorization: 'Basic cm9vdDo=',
      ...(timeoutMs && timeoutMs > 0 ? { 'connect-timeout-ms': String(timeoutMs) } : {}) } });
  signal.throwIfAborted();
  if (!response.ok) throw new E2bNativeError({ code: 'e2b_guest_http_' + response.status });
  const bytes = new Uint8Array(await response.arrayBuffer());
  signal.throwIfAborted();
  const stdout: Uint8Array[] = [], stderr: Uint8Array[] = [];
  let exitCode: number | undefined, terminal = false;
  for (let offset = 0; offset < bytes.length;) {
    if (terminal || bytes.length - offset < 5) throw invalid();
    const flags = bytes[offset];
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0);
    offset += 5;
    if (length > bytes.length - offset || (flags !== 0 && flags !== 2)) throw invalid();
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(bytes.subarray(offset, offset + length))) as unknown; }
    catch { throw invalid(); }
    offset += length;
    if (!object(value)) throw invalid();
    if (flags === 2) {
      if (value.error !== undefined) throw new E2bNativeError({ code: 'e2b_guest_process_failed' });
      terminal = true; continue;
    }
    if (!object(value.event) || exitCode !== undefined) throw invalid();
    const event = value.event;
    if (object(event.data)) {
      for (const [name, parts] of [['stdout', stdout], ['stderr', stderr]] as const) {
        const data = event.data[name];
        if (data !== undefined) {
          if (typeof data !== 'string') throw invalid();
          try { parts.push(decodeBase64(data)); } catch { throw invalid(); }
        }
      }
    } else if (object(event.end)) {
      const code = event.end.exitCode ?? 0;
      if (event.end.exited !== true || typeof code !== 'number' || !Number.isInteger(code)) throw invalid();
      exitCode = code;
    } else if (!object(event.start) || typeof event.start.pid !== 'number') throw invalid();
  }
  if (!terminal || exitCode === undefined) throw invalid();
  return { stdout: concatenate(stdout), stderr: concatenate(stderr), exitCode };
}
