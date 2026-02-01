import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Shared policy for when the stack runner should start the Happier daemon.
 *
 * In `setup-pr` / `review-pr` guided login flows we intentionally start server+UI first,
 * then guide authentication, then start daemon post-auth. Starting the daemon before
 * credentials exist can strand it in its own auth flow (lock held, no machine registration),
 * which leads to "no machines" in the UI.
 */

export function credentialsPathForCliHomeDir(cliHomeDir) {
  return join(String(cliHomeDir ?? ''), 'access.key');
}

export function hasStackCredentials({ cliHomeDir }) {
  if (!cliHomeDir) return false;
  return existsSync(credentialsPathForCliHomeDir(cliHomeDir));
}

export function isAuthFlowEnabled(env) {
  const v = (env?.HAPPIER_STACK_AUTH_FLOW ?? '').toString().trim();
  return v === '1' || v.toLowerCase() === 'true';
}

/**
 * Returns { ok: boolean, reason: string } where ok=true means it's safe to start the daemon now.
 * When ok=false, callers should either:
 * - run interactive auth first (TTY), or
 * - skip daemon start without error in orchestrated auth flows, or
 * - fail closed in non-interactive contexts.
 */
export function daemonStartGate({ env, cliHomeDir }) {
  if (hasStackCredentials({ cliHomeDir })) {
    return { ok: true, reason: 'credentials_present' };
  }
  if (isAuthFlowEnabled(env)) {
    // Orchestrated auth flow (setup-pr/review-pr): keep server/UI up and let the orchestrator
    // run guided login; starting the daemon now is counterproductive.
    return { ok: false, reason: 'auth_flow_missing_credentials' };
  }
  return { ok: false, reason: 'missing_credentials' };
}

export function formatDaemonAuthRequiredError({ stackName, cliHomeDir }) {
  const name = (stackName ?? '').toString().trim() || 'main';
  const path = credentialsPathForCliHomeDir(cliHomeDir);
  return (
    `[local] daemon auth required: credentials not found for stack "${name}".\n` +
    `[local] expected: ${path}\n` +
    `[local] fix: run \`happier auth login\` (stack-scoped), or re-run with UI enabled to complete guided login.`
  );
}
