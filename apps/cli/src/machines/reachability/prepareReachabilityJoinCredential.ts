import { createHash } from 'node:crypto';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { AccessProviderSelectionV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { computeCanonicalDomainSeparatedHexDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { machineSecretGrantSubjectKey } from '@happier-dev/deployment-protocol';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { ApiMachineClient } from '@/api/apiMachine';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createAccountPluginSecretCustodyRouter } from '@/plugins/runtime/context/accountPluginSecretCustody';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { writeMachineConnectorSecretGrantForHost, prepareMachineConnectorSecretGrantRemovalForHost,
  type MachineConnectorSecretGrantHostRequest } from '@/deployments/secrets/readEnvironmentSecretLaunchAdmissionForHost';

const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };

export function reachabilityConnectorSubject(selection: Readonly<Pick<AccessProviderSelectionV1, 'provider' | 'config'>>,
  target: Readonly<{ machineId: string; installationId: string }>) {
  return { v: 1 as const, kind: 'connectorToken' as const, machineId: target.machineId,
    installationId: target.installationId, provider: selection.provider,
    connectorId: computeCanonicalDomainSeparatedHexDigest('happier.machine-reachability.connector-config.v1',
      [createCanonicalJsonSigningInput(selection.config)]) };
}

/** Account material never becomes a role input or a plan: only the existing K4 ref leaves. */
export async function withReachabilityJoinCredential<T>(input: Readonly<{
  selection: AccessProviderSelectionV1;
  target: Readonly<{ serverId: string; machineId: string; installationId: string }>;
  runtime: NonNullable<Awaited<ReturnType<ApiMachineClient['resolveMachineSetupRuntime']>>>;
  machineAdmission: Readonly<{ actorAccountId: string; custodianAccountId: string }>;
  installationPublicKey: Uint8Array;
  installationIdentityFile?: string;
  context: ActionExecutorContext;
  signal: AbortSignal;
  isCurrent(): Promise<boolean>;
}>, consume: (grant: Readonly<{ grantRef: string; contentDigest: string; grantRequest: MachineConnectorSecretGrantHostRequest }>) => Promise<T>): Promise<T> {
  const selected = input.selection.credentialRefs.find(reference => reference.purpose === 'network.join');
  if (!selected) return refuse('needsAuth');
  if (selected.credentialRef.kind !== 'savedSecret') return refuse('credential_unavailable');
  const requester = readRequesterAccountActionContext(input.context.externalActionExecutionAuthorization);
  if (!requester && input.machineAdmission.actorAccountId !== input.machineAdmission.custodianAccountId) {
    return refuse('credential_unavailable');
  }
  const isCurrent = async () => !input.signal.aborted && await input.isCurrent()
    && !!input.runtime.isCurrent && await input.runtime.isCurrent() && await input.runtime.isCustodyCurrent()
    && (!requester || await requester.isCurrent());
  const assertCurrent = async () => { if (!await isCurrent()) return refuse('approval_stale'); };
  await assertCurrent();
  const credentials = requester?.credentials ?? input.runtime.credentials;
  const serverHttpBaseUrl = requester?.serverHttpBaseUrl ?? input.runtime.serverHttpBaseUrl;
  let localContext: ReturnType<typeof createInvocationSavedSecretOperationContextV1> | undefined;
  const operationContext = requester?.savedSecretOperationContext ?? await (async () => {
    const snapshot = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => bootstrapAccountSettingsContext({
      credentials, signal: input.signal, mode: 'blocking', refresh: 'force', publication: 'invocation',
      honorAccountSettingsModeEnv: false, shouldCommit: () => !input.signal.aborted,
    }));
    await assertCurrent();
    if (snapshot.source !== 'network') return refuse('saved_secret_unavailable');
    localContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
      machineAdmission: input.machineAdmission, serverHttpBaseUrl, isCurrent });
    return localContext;
  })();
  const subject = reachabilityConnectorSubject(input.selection, input.target);
  const grantRequest = { credentials, context: input.context, signal: input.signal,
    // Signed storage operands use the admitted Home identity, not its caller-local profile label.
    serverId: input.context.externalActionExecutionAuthorization?.binding.serverIdentityId ?? input.target.serverId,
    serverHttpBaseUrl, hostMachineId: input.target.machineId,
    hostInstallationId: input.target.installationId, subject, assertCurrent,
    ...(input.installationIdentityFile ? { installationIdentityFile: input.installationIdentityFile } : {}),
  } satisfies MachineConnectorSecretGrantHostRequest;
  try {
    const reference = selected.credentialRef;
    const custody = createAccountPluginSecretCustodyRouter({ operationContext,
      accountScopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token) }).bindReadCustody({
      signal: input.signal, isCurrent: () => !input.signal.aborted && operationContext.readSnapshot() !== null,
    });
    if (!custody) return refuse('credential_unavailable');
    return await custody.withSecrets({ references: [{ ref: reference.ref, revision: reference.resourceRevision }],
      signal: input.signal }, async material => {
      await assertCurrent();
      material.assertCurrent();
      const admittedRequest: MachineConnectorSecretGrantHostRequest = { ...grantRequest,
        assertCurrent: async () => { await assertCurrent(); material.assertCurrent(); } };
      const remove = await prepareMachineConnectorSecretGrantRemovalForHost({ ...admittedRequest,
        grantRef: machineSecretGrantSubjectKey(subject) });
      try {
        const bytes = new TextEncoder().encode(material.read(reference.ref));
        const contentDigest = createHash('sha256').update(bytes).digest('hex');
        let grant: Awaited<ReturnType<typeof writeMachineConnectorSecretGrantForHost>>;
        try {
          grant = await writeMachineConnectorSecretGrantForHost({ ...admittedRequest,
            installationPublicKey: input.installationPublicKey, token: bytes });
        } finally { bytes.fill(0); }
        if (grant.grantRef !== machineSecretGrantSubjectKey(subject)) return refuse('invalid_action_output');
        return await consume({ grantRef: grant.grantRef, contentDigest, grantRequest: admittedRequest });
      } finally { await remove(); }
    });
  } finally { localContext?.withdrawCatalog(); }
}
