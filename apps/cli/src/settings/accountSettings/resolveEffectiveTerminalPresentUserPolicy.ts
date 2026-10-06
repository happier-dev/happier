import axios from 'axios';
import { ACCOUNT_SECURITY_PATH_V1, AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { combineTerminalPresentUserPolicies, AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import type { TerminalPresentUserPolicy } from '@happier-dev/protocol/actions/invocationAuthority';
import { configuration } from '@/configuration';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAccountSettingsScopeKey } from './accountSettingsScopeKey';
import { ACCOUNT_SETTINGS_REQUEST_TIMEOUT_MS } from './accountSettingsRequestTimeout';

export type TerminalPresentUserPolicyScope = Readonly<{ token: string; serverHttpBaseUrl?: string }>;

// This security projection is independent of the sealed-settings document and its TTL.
const accountPolicies = new Map<string, TerminalPresentUserPolicy>();
const pendingRefreshes = new Map<string, Promise<TerminalPresentUserPolicy>>();
const initializedScopes = new Set<string>();

function scopeKey(scope: TerminalPresentUserPolicyScope): string {
  return createAccountSettingsScopeKey({
    cachePath: normalizeServerHttpBaseUrl(scope.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()),
    token: scope.token,
  });
}

export function resolveEffectiveTerminalPresentUserPolicy(
  scope?: TerminalPresentUserPolicyScope,
): TerminalPresentUserPolicy {
  return combineTerminalPresentUserPolicies(
    configuration.terminalPresentUserPolicy,
    scope ? accountPolicies.get(scopeKey(scope)) : undefined,
  );
}

export function buildTerminalAuthorityCeiling(scope?: TerminalPresentUserPolicyScope): Readonly<{
  authorityCeiling?: 'account_automation';
}> {
  return resolveEffectiveTerminalPresentUserPolicy(scope) === 'disallowed'
    ? { authorityCeiling: 'account_automation' }
    : {};
}

export function buildTerminalAuthorityCeilingHttpHeaders(scope?: TerminalPresentUserPolicyScope): Readonly<Record<string, string>> {
  return resolveEffectiveTerminalPresentUserPolicy(scope) === 'disallowed'
    ? { [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' }
    : {};
}

/** Loopback admission waits for a reconnect observation already in flight. */
export async function waitForTerminalPresentUserPolicyRefresh(scope?: TerminalPresentUserPolicyScope): Promise<TerminalPresentUserPolicy> {
  if (scope) await pendingRefreshes.get(scopeKey(scope));
  return resolveEffectiveTerminalPresentUserPolicy(scope);
}

export function initializeTerminalPresentUserPolicy(scope: TerminalPresentUserPolicyScope): Promise<TerminalPresentUserPolicy> {
  const key = scopeKey(scope);
  const pending = pendingRefreshes.get(key);
  if (pending) return pending;
  return initializedScopes.has(key)
    ? Promise.resolve(resolveEffectiveTerminalPresentUserPolicy(scope))
    : refreshTerminalPresentUserPolicy(scope);
}

export function refreshTerminalPresentUserPolicy(scope: TerminalPresentUserPolicyScope): Promise<TerminalPresentUserPolicy> {
  const key = scopeKey(scope);
  const pending = pendingRefreshes.get(key);
  if (pending) return pending;
  initializedScopes.add(key);
  const refresh = fetchTerminalPresentUserPolicy(scope);
  pendingRefreshes.set(key, refresh);
  const release = () => { if (pendingRefreshes.get(key) === refresh) pendingRefreshes.delete(key); };
  void refresh.then(release, release);
  return refresh;
}

async function fetchTerminalPresentUserPolicy(scope: TerminalPresentUserPolicyScope): Promise<TerminalPresentUserPolicy> {
  const serverHttpBaseUrl = normalizeServerHttpBaseUrl(scope.serverHttpBaseUrl ?? resolveServerHttpBaseUrl());
  try {
    const response = await axios.get<unknown>(`${serverHttpBaseUrl}${ACCOUNT_SECURITY_PATH_V1}`, {
      headers: {
        Authorization: `Bearer ${scope.token}`,
        ...buildTerminalAuthorityCeilingHttpHeaders({ ...scope, serverHttpBaseUrl }),
      },
      timeout: ACCOUNT_SETTINGS_REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (response.status >= 200 && response.status < 300) {
      const parsed = AccountSecurityGetResponseV1Schema.safeParse(response.data);
      if (parsed.success) accountPolicies.set(scopeKey({ ...scope, serverHttpBaseUrl }), parsed.data.terminalPresentUserPolicy);
    }
  } catch {
    // An unavailable projection retains the last value, or the protocol's allowed default.
  }
  return resolveEffectiveTerminalPresentUserPolicy({ ...scope, serverHttpBaseUrl });
}
