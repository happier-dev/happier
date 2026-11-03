import type { RpcHandlerContext } from '@/api/rpc/types';
import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { issueMcpRequestAuthCapability, type McpRequestAuthIssuanceContext } from '@/mcp/runtime/issueMcpRequestAuthCapability';
import type { McpRequestAuthCapability, McpRequestAuthPort } from '@/mcp/runtime/mcpRequestAuth';
import { logger } from '@/ui/logger';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

export type McpTestRequestAuthAttachment = McpRequestAuthCapability & Readonly<{ cleanup(): Promise<void> }>;
export type IssueMcpTestRequestAuth = (
  input: Parameters<McpRequestAuthPort['open']>[0],
  operationContext: SavedSecretOperationContextV1 | null,
  ingress?: RpcHandlerContext,
) => Promise<McpTestRequestAuthAttachment>;

/** Finite Machine Test borrows the daemon's incumbent issuer and descriptor retirement. */
export function createDaemonMcpRequestAuthForTest(params: Readonly<{
  credentials: StoredCredentials;
  /** Exact private finite-operation scope; absent retains incumbent daemon behavior. */
  operationContext?: SavedSecretOperationContextV1;
  materializationBaseDir: string;
  establishedOwner: McpRequestAuthIssuanceContext['establishedOwner'];
  activatePurposeBindings: McpRequestAuthIssuanceContext['activatePurposeBindings'];
  registry: McpRequestAuthIssuanceContext['registry'];
  getHttpPort(): number;
  isCurrent(): boolean;
}>): IssueMcpTestRequestAuth {
  return async (input, operationContext, ingress) => {
    const signal = ingress?.signal ?? new AbortController().signal;
    const scopeKey = params.operationContext
      ? runWithServerHttpBaseUrl(params.operationContext.serverHttpBaseUrl, () => resolveAccountSettingsScopeKey(params.credentials))
      : resolveAccountSettingsScopeKey(params.credentials);
    const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
    const readSnapshot = operationContext?.readSnapshot ?? getActiveAccountSettingsSnapshot;
    const isCurrent = () => params.isCurrent() && !signal.aborted
      && (params.operationContext
        ? operationContext === params.operationContext && params.operationContext.credentials === params.credentials
        : getActiveAccountSettingsSnapshotLifetimeToken() === lifetime
          && getActiveAccountSettingsSnapshot()?.scopeKey === scopeKey)
      && readSnapshot()?.scopeKey === scopeKey
      && (!operationContext || operationContext.credentials.token === params.credentials.token);
    const inactive = () => {
      if (!params.operationContext) return new Error('mcp_request_auth_not_active');
      try { logger.warnLocalFile('[MCP] Test request-auth admission refused', { code: 'mcp_request_auth_not_active',
        phase: 'mcp_test_request_auth_admission', reason: 'operation_scope_not_current' }); }
      catch { /* Preserve the typed authority failure. */ }
      return Object.assign(new Error('mcp_request_auth_not_active'), { code: 'mcp_request_auth_not_active',
        details: { phase: 'mcp_test_request_auth_admission' } });
    };
    const assertCurrent = async (requestSignal: AbortSignal) => {
      requestSignal.throwIfAborted();
      if (!isCurrent() || operationContext && !await operationContext.isCurrent(requestSignal)) {
        throw inactive();
      }
      requestSignal.throwIfAborted();
      if (!isCurrent()) throw inactive();
    };
    let retire: (() => Promise<void>) | undefined;
    const capability = await issueMcpRequestAuthCapability(input, {
      materializationBaseDir: params.materializationBaseDir,
      establishedOwner: params.establishedOwner,
      activatePurposeBindings: params.activatePurposeBindings,
      registry: params.registry, httpPort: params.getHttpPort(),
      readAccountSettingsSnapshot: readSnapshot, isCurrent, assertCurrent,
      ...(operationContext ? { operationContext } : { catalogCredentials: params.credentials }),
      registerLifetimeCleanup: cleanup => { retire = cleanup; return () => undefined; },
    }, signal);
    return { ...capability, cleanup: async () => { await retire?.(); } };
  };
}
