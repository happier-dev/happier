import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonAgentInstallStartRequestSchema, DaemonAgentInstallReadRequestSchema, DaemonAgentInstallCancelRequestSchema, DaemonAgentInstallListRequestSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { getDaemonAgentInstallJobOwner, type AgentInstallJobOwner } from '@/capabilities/installJobs/agentInstallJobOwner';
import type { RpcHandlerRegistrar, RpcHandlerContext } from '../rpc/types';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { refreshActiveAcpCatalog, refreshDaemonAcpCatalog } from '@/agent/acp/catalog/hydrateAcpCatalog';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readStoredCredentials } from '@/persistence';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readMemberAgentInstallExecutor, type MemberAgentInstallExecutionDeps } from '@/capabilities/installJobs/memberInstallExecution';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';

export function registerMachineAgentInstallJobRpcHandlers(params: { rpcHandlerManager: RpcHandlerRegistrar; owner?: AgentInstallJobOwner;
  deps?: MemberAgentInstallExecutionDeps }): void {
  const owner = params.owner ?? getDaemonAgentInstallJobOwner();
  const invalid = { ok: false as const, errorCode: 'invalid_request' as const, error: 'Invalid agent install job request' };
  const unavailable = { ok: false as const, errorCode: 'install_unavailable' as const,
    error: 'Agent jobs require current Account admission.' };
  const memberUnavailable = { ok: false as const, errorCode: 'member_install_unavailable' as const,
    error: 'Agent installation requires available isolated member execution on Linux.' };
  const admittedAccount = async (context?: RpcHandlerContext): Promise<string | null> => {
    if (!context?.machineAdmission || context.signal.aborted
      || !context.verifyMachineAdmissionCurrent) return null;
    try { return await context.verifyMachineAdmissionCurrent() && !context.signal.aborted ? context.machineAdmission.actorAccountId : null; }
    catch { return null; }
  };
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_AGENTS_INSTALL_START, async (raw: unknown, context?: RpcHandlerContext) => {
    const parsed = DaemonAgentInstallStartRequestSchema.safeParse(raw);
    if (!parsed.success) return invalid;
    const accountId = await admittedAccount(context);
    // Contextless calls are local owner APIs. Every transported call consumes
    // verified ingress, including built-in Agent jobs and their later reads.
    if (context && !accountId || parsed.data.definitionId !== undefined && !accountId) return unavailable;
    if (parsed.data.intent === 'uninstall' && context?.machineAdmission?.role !== 'manage' && context) return unavailable;
    const executeMember = accountId ? await readMemberAgentInstallExecutor(context!, params.deps).catch(error => {
      context!.signal.throwIfAborted();
      if (isPluginError(error) && error.code === 'agent_isolation_unavailable') return null;
      throw error;
    }) : undefined;
    if (executeMember === null) return memberUnavailable;
    const account = accountId ? { accountId, ...(executeMember ? { executeMember } : {}) } : undefined;
    const start = async (selectedAccount: Parameters<AgentInstallJobOwner['start']>[1] = account) => {
      const started = owner.start(parsed.data, selectedAccount);
      if (!started.ok || !parsed.data.waitForTerminal) return started;
      // This is still the admitted install call. Read/cancel the owner's exact
      // job locally, without another transport admission or permission decision.
      const cancel = () => { void owner.cancel({ jobId: started.jobId }, accountId ?? undefined); };
      context?.signal.addEventListener('abort', cancel, { once: true });
      if (context?.signal.aborted) cancel();
      try {
        const terminal = await owner.read({ jobId: started.jobId, cursor: 0, waitForTerminal: true }, accountId ?? undefined);
        if (!terminal.ok) return terminal;
        if (terminal.outcome?.kind === 'failed') return { ok: false as const,
          errorCode: terminal.outcome.code === 'cancelled' ? 'cancelled' as const : 'native_effect_failed' as const,
          error: terminal.outcome.message, details: { jobId: started.jobId, outcome: terminal.outcome } };
        return started;
      } finally { context?.signal.removeEventListener('abort', cancel); }
    };
    if (parsed.data.definitionId !== undefined) {
      if (!accountId) return unavailable;
      if (accountId !== context!.machineAdmission!.custodianAccountId) {
        const requester = readRequesterAccountActionContext(context?.callerInputAuthorization);
        const operation = requester?.savedSecretOperationContext ?? context?.requesterSessionBootstrap?.savedSecretOperationContext;
        const operationAccountId = requester?.authorization.binding.accountId ?? context?.requesterSessionBootstrap?.attribution.accountId;
        if (!operation || operationAccountId !== accountId || !await operation.isCurrent()) return unavailable;
        const catalog = await runWithServerHttpBaseUrl(operation.serverHttpBaseUrl, () => refreshActiveAcpCatalog({
          credentials: operation.credentials, operationContext: operation, signal: context?.signal,
        }));
        if (catalog.status !== 'ready' || !await operation.isCurrent() || await admittedAccount(context) !== accountId) return unavailable;
        return start({ ...account!, catalog });
      }
      if (parsed.data.intent !== 'uninstall') {
        // Registry Add writes the Account row before START. The custodian's
        // background observation can still predate that write, just like a guest's.
        // Capture the pin through the same hydration owner before admitting work.
        const credentials = await readStoredCredentials();
        if (!credentials || readAccountIdFromToken(credentials.token) !== accountId
          || getActiveAccountSettingsSnapshot()?.scopeKey !== resolveAccountSettingsScopeKey(credentials)) return unavailable;
        const catalog = await refreshDaemonAcpCatalog({ credentials, signal: context?.signal });
        if (await admittedAccount(context) !== accountId) return unavailable;
        return start({ ...account!, catalog });
      }
    }
    return start();
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_AGENTS_INSTALL_READ, async (raw: unknown, context?: RpcHandlerContext) => {
    const parsed = DaemonAgentInstallReadRequestSchema.safeParse(raw);
    const accountId = await admittedAccount(context);
    if (context && !accountId || parsed.success && owner.isDefinitionJob(parsed.data.jobId) && !accountId) return unavailable;
    return parsed.success ? await owner.read(parsed.data, accountId ?? undefined) : invalid;
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL, async (raw: unknown, context?: RpcHandlerContext) => {
    const parsed = DaemonAgentInstallCancelRequestSchema.safeParse(raw);
    const accountId = await admittedAccount(context);
    if (context && !accountId || parsed.success && owner.isDefinitionJob(parsed.data.jobId) && !accountId) return unavailable;
    return parsed.success ? await owner.cancel(parsed.data, accountId ?? undefined) : invalid;
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST, async (raw: unknown, context?: RpcHandlerContext) => {
    const parsed = DaemonAgentInstallListRequestSchema.safeParse(raw);
    if (!parsed.success) return invalid;
    const accountId = await admittedAccount(context);
    if (context && !accountId) return unavailable;
    return owner.list(accountId ?? undefined);
  });
}
