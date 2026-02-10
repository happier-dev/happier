export type ProbeServerVersionResult =
  | Readonly<{ ok: true; url: string; version: string | null }>
  | Readonly<{ ok: false; url: string; status: number | null; error: string }>;

import http from 'node:http';
import https from 'node:https';

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

function readUrlText(parsedUrl: URL, timeoutMs: number): Promise<ReadUrlTextResult> {
  return new Promise((resolve, reject) => {
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const req = client.request(
      parsedUrl,
      {
        method: 'GET',
        headers: {
          accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
        },
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
          resolve({ status, contentType, body });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('request_timeout'));
    });

    req.on('error', reject);
    req.end();
  });
}
