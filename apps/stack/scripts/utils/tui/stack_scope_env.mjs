import { applyStackActiveServerScopeEnv } from '../auth/stable_scope_id.mjs';

export function applyTuiStackAuthScopeEnv({ env, stackName }) {
  const base = env && typeof env === 'object' ? env : {};
  const name = String(stackName ?? '').trim() || (base.HAPPIER_STACK_STACK ?? '').toString().trim() || 'main';
  // Make credential/daemon state lookups stable per stack, even if the user's shell exported
  // a different HAPPIER_ACTIVE_SERVER_ID (common when main stack is running).
  return applyStackActiveServerScopeEnv({ env: base, stackName: name });
}

