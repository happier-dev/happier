import { findExistingStackCredentialPath, resolveStackCredentialPaths } from './credentials_paths.mjs';

/**
 * Shared policy for when the stack runner should start the Happier daemon.
 *
 * In `setup-pr` / `review-pr` guided login flows we intentionally start server+UI first,
 * then guide authentication, then start daemon post-auth. Starting the daemon before
 * credentials exist can strand it in its own auth flow (lock held, no machine registration),
 * which leads to "no machines" in the UI.
 */

export function credentialsPathForCliHomeDir(cliHomeDir, serverUrl = '', env = process.env) {
  const resolved = resolveStackCredentialPaths({ cliHomeDir, serverUrl, env });
  return (
    findExistingStackCredentialPath({ cliHomeDir, serverUrl, env }) ||
    resolved.serverScopedPath
  );
}

export function hasStackCredentials({ cliHomeDir, serverUrl = '', env = process.env }) {
  if (!cliHomeDir) return false;
  return Boolean(findExistingStackCredentialPath({ cliHomeDir, serverUrl, env }));
}

export function isAuthFlowEnabled(env) {
  const v = (env?.HAPPIER_STACK_AUTH_FLOW ?? '').toString().trim();
  const wait = (env?.HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH ?? '').toString().trim();
  const isTrue = (s) => s === '1' || String(s).toLowerCase() === 'true';
  return isTrue(v) || isTrue(wait);
}

/**
 * Returns { ok: boolean, reason: string } where ok=true means it's safe to start the daemon now.
 * When ok=false, callers should either:
 * - run interactive auth first (TTY), or
 * - skip daemon start without error in orchestrated auth flows, or
 * - fail closed in non-interactive contexts.
 */
export function daemonStartGate({ env, cliHomeDir, serverUrl = '' }) {
  const resolvedServerUrl = String(serverUrl ?? '').trim() || String(env?.HAPPIER_SERVER_URL ?? '').trim();
  if (hasStackCredentials({ cliHomeDir, serverUrl: resolvedServerUrl, env })) {
    return { ok: true, reason: 'credentials_present' };
  }
  if (isAuthFlowEnabled(env)) {
    // Orchestrated auth flow (setup-pr/review-pr): keep server/UI up and let the orchestrator
    // run guided login; starting the daemon now is counterproductive.
    return { ok: false, reason: 'auth_flow_missing_credentials' };
  }
  return { ok: false, reason: 'missing_credentials' };
}

export function formatDaemonAuthRequiredError({ stackName, cliHomeDir, serverUrl = '' }) {
  const name = (stackName ?? '').toString().trim() || 'main';
  const resolved = resolveStackCredentialPaths({ cliHomeDir, serverUrl });
  const path = `${resolved.legacyPath} or ${resolved.serverScopedPath}`;
  const loginCmd =
    name === 'main'
      ? 'hstack auth login --no-open'
      : `hstack stack auth ${name} login --no-open`;
  return (
    `[local] daemon auth required: credentials not found for stack "${name}".\n` +
    `[local] expected: ${path}\n` +
    `[local] fix: run \`${loginCmd}\`.\n` +
    `[local] tip (headless servers): use \`--method=mobile\` to print a QR code / deep link for the mobile app.`
  );
}
