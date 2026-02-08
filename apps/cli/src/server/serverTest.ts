export type ProbeServerVersionResult =
  | Readonly<{ ok: true; url: string; version: string | null }>
  | Readonly<{ ok: false; url: string; status: number | null; error: string }>;

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
  const controller = new AbortController();
  const timeoutMs = resolveTimeoutMs();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      return { ok: false, url, status: res.status, error: `http_${res.status}` };
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('application/json')) {
      const json: any = await res.json();
      const version = typeof json?.version === 'string' ? json.version : null;
      return { ok: true, url, version };
    }

    const text = await res.text();
    return { ok: true, url, version: text.trim() || null };
  } catch (error) {
    return {
      ok: false,
      url,
      status: null,
      error: error instanceof Error ? error.message : 'unknown_error',
    };
  } finally {
    clearTimeout(t);
  }
}

