import { existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveStackCredentialPaths } from './credentials_paths.mjs';
import { decodeJwtPayloadUnsafe } from './decode_jwt_payload_unsafe.mjs';

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
  const allowAccountSwitch =
    (env.HAPPIER_STACK_AUTH_REPAIR_ALLOW_ACCOUNT_SWITCH ?? '').toString().trim() === '1';
  const activeSub = activeToken ? decodeJwtPayloadUnsafe(activeToken)?.sub ?? null : null;
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
  const hostPortPath = String(resolved.hostPortServerScopedPath ?? '').trim();
  if (hostPortPath && hostPortPath !== activePath && !candidates.includes(hostPortPath)) {
    candidates.unshift(hostPortPath);
  }

  const validCandidates = [];
  for (const candidatePath of candidates) {
    const token = readAuthTokenFromCredentialPath(candidatePath);
    if (!token) continue;
    const validated = await validateTokenAgainstServer({ token, serverUrl, timeoutMs });
    if (!validated.ok) continue;

    validCandidates.push({ candidatePath, token, sub: decodeJwtPayloadUnsafe(token)?.sub ?? null });
    if (!allowAccountSwitch) {
      // If we know the intended account for the active scope (JWT sub), avoid silently repairing
      // from a different account's credentials.
      if (activeSub && String(activeSub) !== String(decodeJwtPayloadUnsafe(token)?.sub ?? '')) {
        continue;
      }
      // If multiple valid candidates exist and we can't prove they refer to the same account,
      // fail closed to avoid a silent account switch.
      //
      // (We'll decide below once we've collected all valid candidates.)
      continue;
    }

    try {
      await mkdir(dirname(activePath), { recursive: true });
      await copyFile(candidatePath, activePath);
      await chmod(activePath, 0o600).catch(() => {});
      return { kind: 'repaired', activePath, sourcePath: candidatePath };
    } catch {
      // If we can't write, continue trying other candidates.
    }
  }

  if (!allowAccountSwitch) {
    const matching =
      activeSub
        ? validCandidates.filter((c) => c.sub && String(c.sub) === String(activeSub))
        : validCandidates;

    if (matching.length === 1) {
      const chosen = matching[0];
      try {
        await mkdir(dirname(activePath), { recursive: true });
        await copyFile(chosen.candidatePath, activePath);
        await chmod(activePath, 0o600).catch(() => {});
        return { kind: 'repaired', activePath, sourcePath: chosen.candidatePath };
      } catch {
        // fall through to unresolved
      }
    }

    if (!activeSub && matching.length > 1) {
      const subs = new Set(matching.map((c) => c.sub).filter(Boolean).map((s) => String(s)));
      if (subs.size === 1 && subs.values().next().value) {
        const chosen = matching[0];
        try {
          await mkdir(dirname(activePath), { recursive: true });
          await copyFile(chosen.candidatePath, activePath);
          await chmod(activePath, 0o600).catch(() => {});
          return { kind: 'repaired', activePath, sourcePath: chosen.candidatePath };
        } catch {
          // fall through to unresolved
        }
      }
    }
  }

  return {
    kind: 'unresolved',
    activePath,
    attemptedPaths: candidates,
    status: activeValid.status,
  };
}
