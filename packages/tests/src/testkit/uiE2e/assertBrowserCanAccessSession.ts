import type { Page } from '@playwright/test';

import { fetchJson } from '../http';

export type BrowserSessionAccessPage = Pick<Page, 'evaluate'>;

type BrowserAuthDiagnostics = Readonly<{
  activeServerId: string | null;
  authCredentialKeys: readonly string[];
}>;

async function readBrowserAuthDiagnostics(page: BrowserSessionAccessPage): Promise<BrowserAuthDiagnostics> {
  return await page.evaluate(() => {
    if (typeof window === 'undefined') {
      return { activeServerId: null, authCredentialKeys: [] };
    }

    const authCredentialKeys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key) continue;
      if (key === 'auth_credentials' || key.startsWith('auth_credentials__srv_')) {
        authCredentialKeys.push(key);
      }
    }

    let activeServerId: string | null = window.sessionStorage?.getItem('activeServerId') ?? null;
    if (!activeServerId) {
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (!key || !key.includes('server-state-v1')) continue;
        const raw = window.localStorage.getItem(key);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as { activeServerId?: unknown };
          activeServerId = typeof parsed.activeServerId === 'string' ? parsed.activeServerId : null;
          if (activeServerId) break;
        } catch {
          // ignore malformed state
        }
      }
    }

    return { activeServerId, authCredentialKeys };
  });
}

async function readBrowserBearerToken(page: BrowserSessionAccessPage): Promise<string> {
  const token = await page.evaluate(() => {
    if (typeof window === 'undefined' || !window.localStorage) return null;

    const credentials: Array<Readonly<{ key: string; token: string }>> = [];
    let activeServerId: string | null = window.sessionStorage?.getItem('activeServerId') ?? null;

    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;

      if (key.includes('server-state-v1') && !activeServerId) {
        try {
          const parsed = JSON.parse(raw) as { activeServerId?: unknown };
          activeServerId = typeof parsed.activeServerId === 'string' ? parsed.activeServerId : null;
        } catch {
          // ignore malformed server state
        }
        continue;
      }

      if (key !== 'auth_credentials' && !key.startsWith('auth_credentials__srv_')) continue;
      try {
        const parsed = JSON.parse(raw) as { token?: unknown; secret?: unknown };
        const candidate = typeof parsed.token === 'string' && parsed.token.trim()
          ? parsed.token.trim()
          : typeof parsed.secret === 'string' && parsed.secret.trim()
            ? parsed.secret.trim()
            : '';
        if (candidate) credentials.push({ key, token: candidate });
      } catch {
        // ignore malformed credentials
      }
    }

    if (credentials.length === 0) return null;
    if (!activeServerId) return credentials[credentials.length - 1]?.token ?? null;

    const expectedKeyFragment = `auth_credentials__srv_${activeServerId.toLowerCase()}`;
    for (let index = credentials.length - 1; index >= 0; index -= 1) {
      const entry = credentials[index];
      if (entry?.key.toLowerCase().includes(expectedKeyFragment)) return entry.token;
    }

    return credentials.find((entry) => entry.key === 'auth_credentials')?.token
      ?? credentials[credentials.length - 1]?.token
      ?? null;
  });

  if (typeof token === 'string' && token.trim()) return token.trim();
  throw new Error('missing browser auth token in localStorage');
}

function jsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 500) ?? 'null';
  } catch {
    return String(value).slice(0, 500);
  }
}

export async function assertBrowserCanAccessSession(params: Readonly<{
  page: BrowserSessionAccessPage;
  serverUrl: string;
  sessionId: string;
  timeoutMs?: number;
  intervalMs?: number;
}>): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 30_000;
  const intervalMs = params.intervalMs ?? 500;
  const token = await readBrowserBearerToken(params.page);
  const authDiagnostics = await readBrowserAuthDiagnostics(params.page);
  const headers = { Authorization: `Bearer ${token}` };
  const startedAt = Date.now();
  let lastProfileStatus: number | null = null;
  let lastProfileAccountId: string | null = null;
  let lastProfilePreview: string | null = null;
  let lastSessionStatus: number | null = null;
  let lastSessionPreview: string | null = null;
  let lastError: string | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const profile = await fetchJson<{ id?: unknown }>(`${params.serverUrl}/v1/account/profile`, {
        headers,
        timeoutMs: 5_000,
      });
      lastProfileStatus = profile.status;
      lastProfileAccountId = typeof profile.data?.id === 'string' ? profile.data.id : null;
      lastProfilePreview = jsonPreview(profile.data);

      const session = await fetchJson<{ session?: { id?: unknown } }>(
        `${params.serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}`,
        {
          headers,
          timeoutMs: 5_000,
        },
      );
      lastSessionStatus = session.status;
      lastSessionPreview = jsonPreview(session.data);

      if (profile.status === 200 && session.status === 200 && session.data?.session?.id === params.sessionId) {
        return;
      }
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error([
    'Browser account cannot access daemon-created session',
    `serverUrl=${params.serverUrl}`,
    `sessionId=${params.sessionId}`,
    `browserAccountId=${lastProfileAccountId ?? 'unknown'}`,
    `browserActiveServerId=${authDiagnostics.activeServerId ?? 'unknown'}`,
    `browserAuthCredentialKeys=${authDiagnostics.authCredentialKeys.join(',') || 'none'}`,
    `profileStatus=${lastProfileStatus ?? 'none'}`,
    `sessionStatus=${lastSessionStatus ?? 'none'}`,
    `lastError=${lastError ?? 'none'}`,
    `profilePreview=${lastProfilePreview ?? 'none'}`,
    `sessionPreview=${lastSessionPreview ?? 'none'}`,
  ].join(' | '));
}
