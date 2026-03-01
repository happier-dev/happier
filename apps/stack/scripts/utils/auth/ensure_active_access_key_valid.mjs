import { existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveStackCredentialPaths } from './credentials_paths.mjs';

function readAuthTokenFromCredentialPath(path) {
  const p = String(path ?? '').trim();
  if (!p || !existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf-8').trim();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.token === 'string' && parsed.token.trim()) {
        return parsed.token.trim();
      }
    } catch {
      // fall through
    }
    return raw;
  } catch {
    return null;
  }
}

async function validateTokenAgainstServer({ token, serverUrl, timeoutMs }) {
  const t = String(token ?? '').trim();
  if (!t) return { ok: false, status: null };
  const base = String(serverUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, status: null };

  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), Math.max(100, timeoutMs ?? 2_500));
  try {
    const res = await fetch(`${base}/v1/account/profile`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${t}` },
      signal: ctl.signal,
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { ok: false, status: null };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Ensures the active server-scoped `access.key` file is usable for API calls.
 *
 * Context:
 * - stack daemons often force a stable `HAPPIER_ACTIVE_SERVER_ID` (e.g. stack_<name>__id_default)
 * - interactive logins may have written credentials under the url-hash server id (env_<hash>)
 * - if the stable-scoped credentials are missing or stale, the daemon will fail to register the machine (401)
 *
 * This helper validates the active server-scoped token against `/v1/account/profile`. If it fails,
 * it tries fallback credentials (url-hash scoped, then legacy) and copies the first valid candidate
 * into the active server-scoped path.
 */
export async function ensureActiveAccessKeyValid({ cliHomeDir, serverUrl, env = process.env, timeoutMs = 2_500 }) {
  const resolved = resolveStackCredentialPaths({ cliHomeDir, serverUrl, env });

  const activePath = resolved.serverScopedPath;
  const activeToken = readAuthTokenFromCredentialPath(activePath);
  const activeValid = activeToken
    ? await validateTokenAgainstServer({ token: activeToken, serverUrl, timeoutMs })
    : { ok: false, status: null };

  if (activeValid.ok) {
    return { kind: 'ok', activePath };
  }

  const candidates = [resolved.urlHashServerScopedPath, resolved.legacyPath]
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .filter((p) => p !== activePath);

  for (const candidatePath of candidates) {
    const token = readAuthTokenFromCredentialPath(candidatePath);
    if (!token) continue;
    const validated = await validateTokenAgainstServer({ token, serverUrl, timeoutMs });
    if (!validated.ok) continue;

    try {
      await mkdir(dirname(activePath), { recursive: true });
      await copyFile(candidatePath, activePath);
      await chmod(activePath, 0o600).catch(() => {});
      return { kind: 'repaired', activePath, sourcePath: candidatePath };
    } catch {
      // If we can't write, continue trying other candidates.
    }
  }

  return {
    kind: 'unresolved',
    activePath,
    attemptedPaths: candidates,
    status: activeValid.status,
  };
}

