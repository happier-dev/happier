export type ProbeServerVersionResult =
  | Readonly<{ ok: true; url: string; version: string | null }>
  | Readonly<{ ok: false; url: string; status: number | null; error: string }>;

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

function resolveTimeoutMs(): number {
  const raw = Number(process.env.HAPPIER_SERVER_TEST_TIMEOUT_MS ?? '');
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 5000;
}

export async function probeServerVersion(serverUrlRaw: string): Promise<ProbeServerVersionResult> {
  const serverUrl = String(serverUrlRaw ?? '').trim().replace(/\/+$/, '');
  if (!serverUrl) {
    return { ok: false, url: '', status: null, error: 'missing_server_url' };
  }

  const url = `${serverUrl}/v1/version`;
  const timeoutMs = resolveTimeoutMs();

  try {
    const parsedUrl = new URL(url);
    const { status, contentType, body } = await readUrlText(parsedUrl, timeoutMs);

    if (status !== 200) {
      return { ok: false, url, status, error: `http_${status}` };
    }

    if (contentType.includes('application/json')) {
      try {
        const json: any = JSON.parse(body);
        const version = typeof json?.version === 'string' ? json.version : null;
        return { ok: true, url, version };
      } catch (error) {
        return {
          ok: false,
          url,
          status: null,
          error: error instanceof Error ? error.message : 'invalid_json',
        };
      }
    }

    return { ok: true, url, version: body.trim() || null };
  } catch (error) {
    return {
      ok: false,
      url,
      status: null,
      error: error instanceof Error ? error.message : 'unknown_error',
    };
  }
}

type ReadUrlTextResult = Readonly<{ status: number; contentType: string; body: string }>;

function decodeChunkedBody(raw: string): string {
  let cursor = 0;
  let decoded = '';

  while (cursor < raw.length) {
    const lineEnd = raw.indexOf('\r\n', cursor);
    if (lineEnd === -1) break;

    const sizeLine = raw.slice(cursor, lineEnd).trim();
    const chunkSize = Number.parseInt(sizeLine, 16);
    if (!Number.isFinite(chunkSize) || chunkSize < 0) break;

    cursor = lineEnd + 2;
    if (chunkSize === 0) break;

    decoded += raw.slice(cursor, cursor + chunkSize);
    cursor += chunkSize;

    if (raw.slice(cursor, cursor + 2) === '\r\n') cursor += 2;
  }

  return decoded;
}

function parseRawHttpResponse(raw: string): ReadUrlTextResult {
  const headerEnd = raw.indexOf('\r\n\r\n');
  const headerRaw = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  const bodyRaw = headerEnd === -1 ? '' : raw.slice(headerEnd + 4);

  const headerLines = headerRaw.split('\r\n');
  const statusLine = headerLines[0] ?? '';
  const statusMatch = statusLine.match(/^\s*HTTP\/\d+\.\d+\s+(\d{3})\b/i);
  const status = statusMatch ? Number(statusMatch[1]) : 0;

  const headers: Record<string, string> = {};
  for (const line of headerLines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    headers[key] = value;
  }

  const contentType = String(headers['content-type'] ?? '').toLowerCase();
  const transferEncoding = String(headers['transfer-encoding'] ?? '').toLowerCase();
  const body = transferEncoding.includes('chunked') ? decodeChunkedBody(bodyRaw) : bodyRaw;

  return { status, contentType, body };
}

function readLoopbackHttpUrlTextViaNet(parsedUrl: URL, timeoutMs: number): Promise<ReadUrlTextResult> {
  return new Promise((resolve, reject) => {
    const port = parsedUrl.port ? Number(parsedUrl.port) : 80;
    const host = parsedUrl.hostname;
    const path = `${parsedUrl.pathname}${parsedUrl.search}`;
    const hostHeader = parsedUrl.port ? `${host}:${port}` : host;

    const socket = net.connect({ host, port });
    socket.setEncoding('utf8');

    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new Error('request_timeout'));
    });

    let raw = '';
    socket.on('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nAccept: application/json, text/plain;q=0.9, */*;q=0.8\r\nConnection: close\r\n\r\n`,
      );
    });

    socket.on('data', (chunk) => {
      raw += chunk;
    });

    socket.on('end', () => {
      const parsed = parseRawHttpResponse(raw);
      if (parsed.status <= 0) {
        reject(new Error('invalid_http_response'));
        return;
      }
      resolve(parsed);
    });

    socket.on('error', (error) => {
      reject(error);
    });
  });
}

function readUrlText(parsedUrl: URL, timeoutMs: number): Promise<ReadUrlTextResult> {
  return new Promise((resolve, reject) => {
    const client = parsedUrl.protocol === 'https:' ? https : http;
    const isLoopback = parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '::1';
    if (isLoopback && parsedUrl.protocol === 'http:') {
      readLoopbackHttpUrlTextViaNet(parsedUrl, timeoutMs).then(resolve).catch(reject);
      return;
    }
    const loopbackAgent = isLoopback
      ? parsedUrl.protocol === 'https:'
        ? new https.Agent({ keepAlive: false })
        : new http.Agent({ keepAlive: false })
      : undefined;

    const req = client.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method: 'GET',
        headers: {
          accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
        },
        // Some environments install global proxy agents. Use an explicit Agent for loopback probes
        // so we can reliably validate local servers (and so our tests stay deterministic).
        agent: loopbackAgent,
      },
      (res) => {
        const status = typeof res.statusCode === 'number' ? res.statusCode : 0;
        const contentType = String(res.headers['content-type'] ?? '').toLowerCase();

        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          loopbackAgent?.destroy();
          resolve({ status, contentType, body });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      loopbackAgent?.destroy();
      req.destroy(new Error('request_timeout'));
    });

    req.on('error', (error) => {
      loopbackAgent?.destroy();
      reject(error);
    });
    req.end();
  });
}
