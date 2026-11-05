import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { RequesterAccountActionContext, RetainedRequesterAccountCustody } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { createRequesterConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createRequesterConnectedAccountPurposeBindingRuntime';
import { createHttpTeamCredentialDirectMaterialClient } from '@/daemon/connectedServices/directMaterial/teamCredentialDirectMaterialClient';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { resolveQualifiedConnectedAccountAtomicV4Negotiation } from '@/api/client/qualifiedConnectedAccountApi';
import { fetchServerFeaturesSnapshot, readServerIdentityIdFromFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { projectConnectedAccountPurposeBindingOwner } from '@/plugins/runtime/composition/connectedAccountAssembly';
import { logger } from '@/ui/logger';

/** The parent admits private requester Account custody once before this owner.
 * Subsequent checks inspect only that retained local lease and cancellation.
 * Encryption mode is refreshed only at a new credential-material boundary.
 * This finite composition creates no Session, registry or credential issuer. */
export async function prepareRequesterOperationMaterial(input: Readonly<{
  requesterAccount: RequesterAccountActionContext;
  /** Explicit relationship custody; finite callers keep their original Account lifetime. */
  retainedCustody?: RetainedRequesterAccountCustody;
  requesterIdentity: Exclude<HostRequesterExecutionIdentity, { kind: 'unknown' }> & { homeServerIdentityId: string };
  reloadController: PluginReloadController;
  signal?: AbortSignal;
}>) {
  input.signal?.throwIfAborted();
  const account = input.requesterAccount;
  const operationContext = input.retainedCustody?.savedSecretOperationContext ?? account.savedSecretOperationContext;
  const selected = input.requesterIdentity;
  const binding = account.authorization.binding;
  const matches = () => readRequesterAccountActionContext(account.authorization) === account
    && binding.accountId === selected.requester.accountId
    && binding.serverIdentityId === selected.homeServerIdentityId
    && binding.machineId === selected.requester.machineId
    && binding.installationId === selected.requester.installationId
    && account.serverHttpBaseUrl === operationContext.serverHttpBaseUrl
    && operationContext.credentials === account.credentials;
  const unavailable = () => Object.assign(new PluginError({ code: 'agent_isolation_unavailable',
    message: 'Requester material is unavailable', retryable: false,
    details: { phase: 'requester_material_admission', reason: 'requester_authority_unavailable' } }), { rpcErrorCode: 'agent_isolation_unavailable' });
  if (!matches()) throw unavailable();
  const release = (() => {
    try { return account.retain(); } catch { throw unavailable(); }
  })();
  const lifetime = new AbortController();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const cleanupFailure = () => new PluginError({ code: 'requester_material_cleanup_failed',
    message: 'Requester material cleanup failed', retryable: false,
    details: { phase: 'requester_material_cleanup' } });
  const dispose = () => disposal ??= (async () => {
    disposed = true;
    lifetime.abort();
    try { await release(); } catch { reportCleanupFailure(); throw cleanupFailure(); }
  })();
  const reportCleanupFailure = () => {
    try { logger.warnLocalFile('Requester material cleanup failed', {
      code: 'requester_material_cleanup_failed', phase: 'requester_material_cleanup',
    }); } catch { /* Private diagnostics never replace the primary typed failure. */ }
  };
  const operationSignal = (signal?: AbortSignal) => AbortSignal.any([
    lifetime.signal, ...(input.signal ? [input.signal] : []), ...(signal ? [signal] : []),
  ]);
  const isCurrent = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    input.signal?.throwIfAborted();
    return !disposed && matches() && (!input.retainedCustody || await input.retainedCustody.isCurrent());
  };
  const assertCurrent = async (signal?: AbortSignal) => {
    if (!await isCurrent(signal)) throw unavailable();
  };
  const readMode = async (signal?: AbortSignal) => {
    await assertCurrent(signal);
    const observed = await fetchAccountEncryptionCurrentness({ credentials: account.credentials, token: account.credentials.token,
      serverBaseUrl: account.serverHttpBaseUrl, allowCredentialRecovery: false,
      signal: operationSignal(signal) });
    await assertCurrent(signal);
    return observed.mode;
  };
  const initialize = async (signal?: AbortSignal) => {
    await assertCurrent(signal);
    const featureSnapshot = await fetchServerFeaturesSnapshot({ serverUrl: account.serverHttpBaseUrl,
      token: account.credentials.token, signal: operationSignal(signal) });
    await assertCurrent(signal);
    if (readServerIdentityIdFromFeaturesSnapshot(featureSnapshot) !== selected.homeServerIdentityId) throw unavailable();
    const support = resolveQualifiedConnectedAccountAtomicV4Negotiation(featureSnapshot);
    const directMaterial = createHttpTeamCredentialDirectMaterialClient({ token: account.credentials.token,
      serverUrl: account.serverHttpBaseUrl,
      readRecipientEncryptionMaterial: async signal => {
        const mode = await readMode(signal);
        const encryption = account.credentials.encryption;
        return mode === 'plain' ? { mode: 'plain' } : mode === 'e2ee' && encryption
          ? { mode: 'e2ee', secretKeyOrSeed: encryption.type === 'dataKey' ? encryption.machineKey : encryption.secret }
          : { mode: 'e2ee_unavailable' };
      },
    });
    const runtime = createRequesterConnectedAccountPurposeBindingRuntime({
      operationContext, accountId: selected.requester.accountId,
      machineId: selected.requester.machineId, reloadController: input.reloadController,
      getAccountEncryptionMode: options => readMode(options?.signal), isCurrent,
      allowNativeAccountCredentials: false,
      resolveQualifiedConnectedAccountV4Support: () => {
        if (disposed || input.signal?.aborted || !matches()) throw unavailable();
        return support;
      },
      openTeamDirect: async request => {
        const signal = operationSignal(request.signal);
        await assertCurrent(signal);
        const result = await directMaterial.open({ ...request, signal });
        await assertCurrent(signal);
        return result;
      },
    });
    await assertCurrent(signal);
    return runtime;
  };
  let pending: Promise<Awaited<ReturnType<typeof initialize>>> | undefined;
  const readRuntime = async (signal?: AbortSignal) => {
    try {
      await assertCurrent(signal);
      // One finite invocation shares one demanded initialization; a failed or
      // cancelled initialization retires it, never starts a retry/background loop.
      pending ??= initialize(signal);
      const runtime = await pending;
      await assertCurrent(signal);
      return runtime;
    } catch (error) {
      try { await dispose(); } catch { /* dispose reported its fixed private diagnostic once. */ }
      throw error;
    }
  };
  const readConnectedAccounts = async (signal?: AbortSignal) => {
    const owner = projectConnectedAccountPurposeBindingOwner((await readRuntime(signal)).purposes.owner);
    if (!owner) throw unavailable();
    return owner;
  };
  const runConnectedAccountRead = async <T>(signal: AbortSignal,
    read: (owner: Awaited<ReturnType<typeof readConnectedAccounts>>, signal: AbortSignal) => Promise<T>) => {
    const admittedSignal = operationSignal(signal);
    try {
      const owner = await readConnectedAccounts(admittedSignal);
      const result = await read(owner, admittedSignal);
      await assertCurrent(admittedSignal);
      return result;
    } catch (error) {
      try { await dispose(); } catch { /* Keep the original owner refusal; dispose reports its fixed diagnostic. */ }
      throw error;
    }
  };
  // Finite SCM consumers require only these three asynchronous methods. A real
  // watch consumer explicitly awaits readConnectedAccounts and receives the
  // existing synchronous watch; no deferred/no-op watch is fabricated.
  const connectedAccounts: Pick<NonNullable<ReturnType<typeof projectConnectedAccountPurposeBindingOwner>>,
    'getBinding' | 'listAccounts' | 'materialize'> = {
    getBinding: async request => runConnectedAccountRead(request.signal,
      (owner, signal) => owner.getBinding({ ...request, signal })),
    listAccounts: async request => runConnectedAccountRead(request.signal,
      (owner, signal) => owner.listAccounts({ ...request, signal })),
    materialize: async request => runConnectedAccountRead(request.signal,
      (owner, signal) => owner.materialize({ ...request, signal })),
  };
  return { connectedAccounts, readRuntime, readConnectedAccounts, credentials: account.credentials,
    operationContext, isCurrent, dispose };
}
