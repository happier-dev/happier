import { PluginError } from '../errors.js';
import { MAX_PLUGIN_FETCH_RESPONSE_BODY_BYTES } from './service.js';

function createResponseTooLargeError(): PluginError {
  return new PluginError({
    code: 'plugin_fetch_response_too_large',
    message: 'Plugin fetch response exceeded the stable response-body limit',
  });
}

function hasOversizedDeclaredResponseBody(response: Response): boolean {
  const contentLength = response.headers.get('content-length');
  if (contentLength === null || !/^\d+$/.test(contentLength)) {
    return false;
  }
  const declaredBytes = Number(contentLength);
  return !Number.isSafeInteger(declaredBytes)
    || declaredBytes > MAX_PLUGIN_FETCH_RESPONSE_BODY_BYTES;
}

export async function readBoundedPluginHttpResponseBody(
  response: Response,
  requestAbort: AbortController,
): Promise<Uint8Array> {
  const responseBody = response.body;
  if (!responseBody) {
    return new Uint8Array();
  }
  if (hasOversizedDeclaredResponseBody(response)) {
    const error = createResponseTooLargeError();
    requestAbort.abort(error);
    void responseBody.cancel(error).catch(() => undefined);
    throw error;
  }
  const reader = responseBody.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_PLUGIN_FETCH_RESPONSE_BODY_BYTES - byteLength) {
        const error = createResponseTooLargeError();
        requestAbort.abort(error);
        void reader.cancel(error).catch(() => undefined);
        throw error;
      }
      byteLength += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) return new Uint8Array();
  if (chunks.length === 1) return chunks[0]!;
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
