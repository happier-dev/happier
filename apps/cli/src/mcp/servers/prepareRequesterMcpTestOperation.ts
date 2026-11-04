import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { resolveHostRequesterAgentPlacementForHost, type HostRequesterExecutionIdentity,
  type HostAgentIsolationLaunchSnapshot } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { createDaemonMcpRequestAuthForTest, type IssueMcpTestRequestAuth, type McpTestRequestAuthAttachment } from '@/daemon/connectedServices/requestAuth/createDaemonMcpRequestAuthForTest';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { createCliMcpServerStoreForOperation } from '@/settings/mcp/mcpServerStore';
import type { AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { logger } from '@/ui/logger';
import { readMcpRequestAuthFailureCode } from '@/mcp/runtime/mcpRequestAuth';
import type { ApiMachineClient } from '@/api/apiMachine';
import { prepareRequesterMcpNativeProbe } from '@/mcp/servers/prepareRequesterMcpNativeProbe';
import type { AgentLaunchOperationMaterialization } from '@/daemon/agentIsolation/agentLaunchMaterials';
import { prepareRequesterOperationMaterial } from '@/daemon/connectedServices/purposeBindings/requesterOperationMaterial';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

/** Finite MCP Test composition; native stdio admission remains with its existing
 * execution owner. This never creates a credential issuer or runtime registry. */
export async function prepareRequesterMcpTestOperation(input: Readonly<{
  ingress: RpcHandlerContext;
  requesterIdentity: Exclude<HostRequesterExecutionIdentity, { kind: 'unknown' }> & { homeServerIdentityId: string };
  isolationSnapshot: HostAgentIsolationLaunchSnapshot | undefined;
  requestAuth?: Pick<Parameters<typeof createDaemonMcpRequestAuthForTest>[0], 'materializationBaseDir' | 'registry' | 'getHttpPort'>;
  /** Existing Account-scoped plugin composition, if this operation selects a plugin item. */
  acquirePluginRegistry?: () => Promise<PluginRuntimeRegistryLease>;
  /** Bound by the installed Machine; never a request-supplied native launcher. */
  prepareNativeOperation?: ApiMachineClient['prepareNativeOperation'];
}>) {
  const refusal = (phase: 'requester_mcp_admission' | 'requester_mcp_currentness') => {
    try { logger.warnLocalFile('[MCP] Requester Test preparation refused', {
      code: 'agent_isolation_unavailable', phase, reason: 'requester_authority_unavailable',
    }); } catch { /* Diagnostics cannot replace a typed authority refusal. */ }
    return Object.assign(new PluginError({ code: 'agent_isolation_unavailable', message: 'Requester MCP Test material is unavailable',
      retryable: false, details: { phase, reason: 'requester_authority_unavailable' } }), { rpcErrorCode: 'agent_isolation_unavailable' });
  };
  input.ingress.signal.throwIfAborted();
  const account = readRequesterAccountActionContext(input.ingress.callerInputAuthorization
    ?? input.ingress.localActionContext?.externalActionExecutionAuthorization);
  if (!account) throw refusal('requester_mcp_admission');
  const key = input.ingress.localActionContext?.operationAcceptance?.operationId ?? input.ingress.transportRequestId
    ?? account.authorization.binding.requestId;
  if (!key) throw refusal('requester_mcp_admission');
  let live = true;
  let nativeMaterial: AgentLaunchOperationMaterialization | undefined = Object.freeze({ materializationKey: key,
    environment: Object.freeze({}), selectedMaterials: Object.freeze([]) });
  // Canonical execution identity keeps its existing shape. The independently
  // held Home qualifies material but never becomes a selector property.
  const { homeServerIdentityId: _homeServerIdentityId, ...requesterIdentity } = input.requesterIdentity;
  if (requesterIdentity.kind !== 'isolated') throw refusal('requester_mcp_admission');
  const placement = resolveHostRequesterAgentPlacementForHost({ identity: requesterIdentity, snapshot: input.isolationSnapshot });
  if (placement !== 'daemon' && !input.prepareNativeOperation) throw refusal('requester_mcp_admission');
  const native = placement !== 'daemon' ? await input.prepareNativeOperation!({ requesterIdentity, requesterAccount: account,
    ingress: input.ingress, signal: input.ingress.signal,
    readMaterial: () => live ? nativeMaterial : undefined }) : undefined;
  const material = native ? native.material : await prepareRequesterOperationMaterial({ requesterAccount: account,
    requesterIdentity: input.requesterIdentity, reloadController: pluginReloadController, signal: input.ingress.signal });
  if (!material) { await native?.dispose(); throw refusal('requester_mcp_admission'); }
  const retireMaterial = () => native ? native.dispose() : material.dispose();
  const operationContext = material.operationContext;
  let disposal: Promise<void> | undefined;
  const attachments = new Set<McpTestRequestAuthAttachment>();
  const assertCurrent = async () => {
    input.ingress.signal.throwIfAborted();
    if (!live || !await material.isCurrent(input.ingress.signal)) throw refusal('requester_mcp_currentness');
    input.ingress.signal.throwIfAborted();
  };
  const readSettings = async (refreshCatalog: boolean): Promise<AccountSettingsContext> => {
    await assertCurrent();
    try {
      if (refreshCatalog) await createCliMcpServerStoreForOperation({ operationContext, signal: input.ingress.signal }).readCatalogForOperation();
      await assertCurrent();
      const snapshot = operationContext.readSnapshot();
      if (!snapshot) throw refusal('requester_mcp_currentness');
      return { ...snapshot, whenRefreshed: null };
    } catch (error) {
      try { logger.warnLocalFile('[MCP] Requester Test catalog preparation failed', { phase: 'requester_mcp_catalog', code: 'mcp_catalog_unavailable' }); }
      catch { /* Keep the primary typed catalog/currentness failure. */ }
      throw error;
    }
  };
  let nativeProbe: ReturnType<typeof prepareRequesterMcpNativeProbe> | undefined;
  try {
    nativeProbe = native ? prepareRequesterMcpNativeProbe({
      ingress: input.ingress, requesterIdentity, assertCurrent, materializationKey: key,
      preparedNative: native, replaceMaterial: value => { nativeMaterial = value; },
    }) : undefined;
    if (placement !== 'daemon' && !nativeProbe) throw refusal('requester_mcp_admission');
  } catch (error) {
    live = false;
    nativeMaterial = undefined;
    try { await retireMaterial(); }
    catch {
      try { logger.warnLocalFile('[MCP] Requester Test cleanup failed', { code: 'requester_material_cleanup_failed', phase: 'requester_mcp_cleanup' }); }
      catch { /* Preserve the primary no-effect refusal. */ }
    }
    throw error;
  }
  const issueRequestAuth: IssueMcpTestRequestAuth = async (request, capturedContext, ingress) => {
    await assertCurrent();
    if (capturedContext !== operationContext || ingress !== input.ingress) throw refusal('requester_mcp_admission');
    if (!input.requestAuth) throw Object.assign(new Error('mcp_request_auth_unavailable'), { code: 'mcp_request_auth_unavailable' });
    const runtime = await material.readRuntime(input.ingress.signal);
    await assertCurrent();
    const issuer = createDaemonMcpRequestAuthForTest({ ...input.requestAuth, credentials: material.credentials,
      operationContext, establishedOwner: runtime.established, activatePurposeBindings: runtime.purposes.activatePurposeBindings,
      isCurrent: () => live && !input.ingress.signal.aborted && operationContext.readSnapshot() !== null });
    const attachment = await issuer(request, operationContext, input.ingress).catch((error: unknown) => {
      try { logger.warnLocalFile('[MCP] Requester Test OAuth preparation failed', {
        phase: 'requester_mcp_oauth', code: readMcpRequestAuthFailureCode(error),
      }); } catch { /* Preserve the primary issuer failure. */ }
      throw error;
    });
    attachments.add(attachment);
    try { await assertCurrent(); }
    catch (error) {
      try { await attachment.cleanup(); }
      catch {
        try { logger.warnLocalFile('[MCP] Requester Test cleanup failed', { code: 'requester_material_cleanup_failed', phase: 'requester_mcp_cleanup' }); }
        catch { /* Preserve the primary authority failure. */ }
      } finally { attachments.delete(attachment); }
      throw error;
    }
    return { ...attachment, async cleanup() { try { await attachment.cleanup(); } finally { attachments.delete(attachment); } } };
  };
  const dispose = () => disposal ??= (async () => {
    live = false;
    nativeMaterial = undefined;
    let failed = false;
    for (const attachment of attachments) {
      try { await attachment.cleanup(); } catch { failed = true; }
    }
    attachments.clear();
    try { await retireMaterial(); } catch { failed = true; }
    if (failed) {
      try { logger.warnLocalFile('[MCP] Requester Test cleanup failed', { code: 'requester_material_cleanup_failed', phase: 'requester_mcp_cleanup' }); }
      catch { /* Keep cleanup failure typed and content-free. */ }
      throw new PluginError({ code: 'requester_material_cleanup_failed', message: 'Requester MCP Test cleanup failed',
        retryable: false, details: { phase: 'requester_mcp_cleanup' } });
    }
  })();
  return { credentials: material.credentials, operationContext, readSettings, assertCurrent, issueRequestAuth, nativeProbe, placement,
    ...(input.acquirePluginRegistry ? { acquirePluginRegistry: input.acquirePluginRegistry } : {}), dispose };
}

export type RequesterMcpTestOperation = Awaited<ReturnType<typeof prepareRequesterMcpTestOperation>>;
