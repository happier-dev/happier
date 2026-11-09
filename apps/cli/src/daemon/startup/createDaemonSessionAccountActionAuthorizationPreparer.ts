import { isDeepStrictEqual } from 'node:util';
import type { StoredCredentials } from '@/persistence';
import { readStoredCredentialsForServerId, sameStoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { fetchAccountProfile } from '@/api/accountProfile';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { prepareExternalActionRequesterAccountAuthorizationResult } from '@/api/externalActionExecutionAuthorization';
import { projectSessionActionIssuerRefusal, type ExternalActionIssuerRefusal } from '@/api/externalActionIssuerRefusal';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { resolveAvailableAccountSettings } from '@/settings/accountSettings/resolveAvailableAccountSettings';
import { readManagedMachine } from '@/machines/managed/readManagedMachine';
import { ExternalActionActionIdV1Schema, type ExternalActionExecutionAuthorizationV1, type ExternalActionTargetV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { MANAGED_MACHINE_ACTION_IDS_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { RequesterWorkAttributionV1 } from '@happier-dev/protocol/machines/requesterWorkAttributionV1';
import { resolveExternalActionMachineTarget } from '../externalActions/reconcileExternalActionTarget';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '../externalActions/daemonExternalActionTargetResolver';
import type { createDaemonSessionAccountActionExecutor } from '../agentRuntime/createDaemonSessionAccountActionExecutor';
import { projectRequesterAccountActionAuthorization, type RequesterSessionRuntimeContext } from '../sessionEncryption/requesterSessionCredentials';
import { readOrdinaryRequesterSessionAccountCustodyForHost } from '../sessionEncryption/ordinaryRequesterSessionAccountCustody';

/** Original Session issuer preparation; Home remains the admission and purpose owner. */
export function createDaemonSessionAccountActionAuthorizationPreparer(params: Readonly<{
  credentials: StoredCredentials;
  requesterRuntime: RequesterSessionRuntimeContext | null;
  serverHttpBaseUrl: string;
  machineId: string;
  serverId: string;
  requesterSessionCustodyServerId?: string;
  externalActionAccountId?: string | null;
  resolveCurrentMachineExecutionOriginContext?: (signal?: AbortSignal) => Promise<CurrentMachineExecutionOriginContext | null>;
  resolveServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined | Promise<CliServerFeaturesSnapshot | undefined>;
  isSessionCallerCurrent: Parameters<typeof createDaemonApprovalExecutionOriginCurrentnessFromCredentials>[0]['isSessionCallerCurrent'];
  isRuntimeCurrent(): boolean;
  readTrackedSessionAttribution(sessionId: string): RequesterWorkAttributionV1 | undefined;
}>): NonNullable<Parameters<typeof createDaemonSessionAccountActionExecutor>[0]['prepareExternalActionAuthorization']> {
  const { credentials, requesterRuntime, serverHttpBaseUrl } = params;
  return async ({ operation, authority, isCallerCurrent, sessionActionOrigin, targetMachineId, workflowTarget }) => {
    const refused = (phase: ExternalActionIssuerRefusal['phase'], requiredFact: string) =>
      projectSessionActionIssuerRefusal({ ok: false, phase, requiredFact }, params.machineId, authority.signal);
    // Private/client-only Actions retain their existing Session channel;
    // Home-bound public effects use only the incumbent signed carrier.
    if (
      !ExternalActionActionIdV1Schema.safeParse(operation.actionId)
        .success
    )
      return undefined;
    const installation = readInstallationIdentityIfExistsSync();
    const origin =
      await params.resolveCurrentMachineExecutionOriginContext?.(
        authority.signal,
      );
    if (
      !installation ||
      !origin ||
      origin.machineId !== params.machineId
    )
      return refused('preparation', 'machine_installation_origin');
    // These reads prepare one authorization input. The Home mint below and
    // final publication retain their independent, fresh isCurrent fences.
    if (!await isCallerCurrent()) return refused('preparation', 'active_session_action');
    const [profile, encryption] = await runWithServerHttpBaseUrl(
      serverHttpBaseUrl,
      () => Promise.all([
        fetchAccountProfile({
          token: credentials.token,
          ...(authority.signal ? { signal: authority.signal } : {}),
        }),
        fetchAccountEncryptionCurrentness({
          credentials: credentials, token: credentials.token,
          serverBaseUrl: serverHttpBaseUrl,
          ...(authority.signal ? { signal: authority.signal } : {}),
        }),
      ]),
    );
    if ((requesterRuntime && profile.id !== requesterRuntime.bootstrap.attribution.accountId)
      || !await isCallerCurrent()) return refused('preparation', 'requester_account_profile');

    const payload = decodeJwtPayload(credentials.token);
    const extras = payload?.extras;
    const hint =
      payload?.tokenEpoch ??
      (extras && typeof extras === 'object' && 'tokenEpoch' in extras
        ? extras.tokenEpoch
        : undefined);
    // A missing legacy epoch may propose zero as associated data only.
    // The authenticated Home mint, not this unverified hint, decides it.
    const tokenEpochHint = hint === undefined ? 0 : hint;
    if (
      typeof tokenEpochHint !== 'number' ||
      !Number.isSafeInteger(tokenEpochHint) ||
      tokenEpochHint < 0
    )
      return refused('preparation', 'token_epoch_hint');
    const material =
      credentials.encryption?.type === 'legacy'
        ? {
            type: 'dataKey' as const,
            machineKey: deriveAccountMachineKeyFromRecoverySecret(
              credentials.encryption.secret,
            ),
          }
        : credentials.encryption;
    let selectedMachineId = operation.actionId === 'session.board.item.upsert'
      ? params.machineId : targetMachineId ?? params.machineId;
    if (resolveActionExecutionPlacementForInput(getActionSpec(operation.actionId), operation.input) === 'machine') {
      let ownerMachineId: string | undefined;
      if ((MANAGED_MACHINE_ACTION_IDS_V1 as readonly string[]).includes(operation.actionId)) {
        const parsed = getActionSpec(operation.actionId).inputSchema.safeParse(operation.input);
        if (!parsed.success) return refused('preparation', 'managed_action_input');
        const managedInput: unknown = parsed.data;
        if (managedInput && typeof managedInput === 'object' && 'homeId' in managedInput && managedInput.homeId !== origin.serverIdentityId) return refused('preparation', 'managed_home_identity');
        if (managedInput && typeof managedInput === 'object') {
          const managedId = 'managedId' in managedInput ? managedInput.managedId
            : 'managedMachineId' in managedInput ? managedInput.managedMachineId : undefined;
          if (typeof managedId === 'string') {
            const machine = await readManagedMachine({ credentials, serverHttpBaseUrl,
              homeId: origin.serverIdentityId, managedId, ...(authority.signal ? { signal: authority.signal } : {}) });
            if (machine.id !== managedId || machine.homeId !== origin.serverIdentityId || !machine.controller) return refused('preparation', 'managed_controller_target');
            ownerMachineId = machine.controller.machineId;
          }
        }
      }
      const selected = resolveExternalActionMachineTarget({ actionId: operation.actionId, rawInput: operation.input,
        ...(targetMachineId ? { target: { kind: 'machine', machineId: targetMachineId } } : {}),
        fallbackMachineId: params.machineId, ...(ownerMachineId ? { ownerMachineId } : {}) });
      if (selected.kind !== 'ready') return refused('preparation', 'action_execution_target');
      selectedMachineId = selected.machineId;
    }
    if (workflowTarget && workflowTarget.machineId !== selectedMachineId) return refused('preparation', 'workflow_machine_target');
    const target: ExternalActionTargetV1 = operation.actionId === 'session.board.item.upsert'
      ? { kind: 'session', sessionId: sessionActionOrigin.caller.sessionId }
      : workflowTarget ?? { kind: 'machine', machineId: selectedMachineId };
    const isCurrent = async () => {
      const current = readInstallationIdentityIfExistsSync();
      return (
        current?.installationId === installation.installationId &&
        current.publicKey === installation.publicKey &&
        (await isCallerCurrent())
      );
    };
    const managedContinuation = operation.actionId === 'machines.managed.acquire'
      || operation.actionId === 'machines.managed.bootstrap.retry';
    const accountSettings = managedContinuation
      ? requesterRuntime?.readAccountSettingsSnapshot().settings
        ?? await resolveAvailableAccountSettings({ credentials })
      : null;
    const acceptedCurrentness = managedContinuation
      ? createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
          credentials,
          machineId: params.machineId,
          serverId: params.serverId,
          serverApiUrl: serverHttpBaseUrl,
          isSessionCallerCurrent: params.isSessionCallerCurrent,
          ...(params.resolveServerFeaturesSnapshot
            ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot }
            : {}),
        })
      : undefined;
    if (managedContinuation && (!accountSettings || !acceptedCurrentness)) return refused('preparation', 'managed_continuation_context');
    const preparedAuthorization =
      await prepareExternalActionRequesterAccountAuthorizationResult({
        actionId: operation.actionId,
        input: operation.input,
        requestId: operation.requestId,
        target,
        machineId: selectedMachineId,
        sourceMachineId: params.machineId,
        accountId: profile.id,
        accountEncryptionMode: encryption.mode,
        tokenEpochHint,
        token: credentials.token,
        ...(material ? { material } : {}),
        serverId: params.serverId,
        serverIdentityId: origin.serverIdentityId,
        serverHttpBaseUrl,
        installationId: installation.installationId,
        privateKey: installation.privateKey,
        sessionActionOrigin,
        isCurrent,
        ...(managedContinuation && accountSettings && acceptedCurrentness ? {
          isContinuationCurrent: async (acceptedAuthorization: ExternalActionExecutionAuthorizationV1) => {
            const currentInstallation = readInstallationIdentityIfExistsSync();
            if (authority.signal?.aborted
              || currentInstallation?.installationId !== installation.installationId
              || currentInstallation.publicKey !== installation.publicKey
              || requesterRuntime && !await requesterRuntime.isCurrent()) return false;
            const acceptedOrigin = buildApprovalExecutionOriginV1({
              actionId: operation.actionId,
              input: operation.input,
              targetSessionId: null,
              context: {
                surface: operation.surface ?? 'agent', authority: 'account_automation',
                serverId: params.serverId, serverIdentityId: origin.serverIdentityId,
                runtimeAccountId: profile.id, actionRequestId: operation.requestId,
                actionCaller: sessionActionOrigin.caller,
                defaultSessionId: sessionActionOrigin.caller.sessionId,
                callerPermissionMode: sessionActionOrigin.callerPermissionMode,
                causalPermissionAuthority: sessionActionOrigin.causalPermissionAuthority,
                ...(sessionActionOrigin.workspaceWrites
                  ? { workspaceWrites: sessionActionOrigin.workspaceWrites } : {}),
                sessionInputSource: { sourceSessionId: sessionActionOrigin.caller.sessionId,
                  sourceTurnId: sessionActionOrigin.sourceTurnId,
                  ...(sessionActionOrigin.sourceInputId ? { sourceInputId: sessionActionOrigin.sourceInputId } : {}),
                  via: 'action' },
                sessionAgentSpawnPolicyV1: accountSettings.sessionAgentSpawnPolicyV1,
                externalActionExecutionAuthorization: acceptedAuthorization,
                externalActionTarget: target,
                signExternalActionApprovalInput: ({ actionId, input: actionInput, target: actionTarget, requesterConfirmation, sessionTargetsV1 }) =>
                  signExternalActionApprovalInputV1({ authorizationToken: acceptedAuthorization.token,
                    actionId, input: actionInput, target: actionTarget, privateKey: installation.privateKey,
                    ...(requesterConfirmation ? { requesterConfirmation } : {}),
                    ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}) }),
              },
            });
            return acceptedOrigin !== null && await acceptedCurrentness({
              origin: acceptedOrigin, actionInput: operation.input,
              ...(authority.signal ? { signal: authority.signal } : {}),
            });
          },
        } : {}),
        ...(authority.signal ? { signal: authority.signal } : {}),
      });
    if ('ok' in preparedAuthorization)
      return projectSessionActionIssuerRefusal(preparedAuthorization, params.machineId, authority.signal);
    let authorization: ExternalActionExecutionAuthorizationV1 | null = preparedAuthorization.authorization;
    if (authorization && requesterRuntime)
      authorization =
        await requesterRuntime.bootstrap.projectExternalActionAuthorization(
          authorization,
          origin.serverIdentityId,
          authority.signal,
        );
    else if (authorization) {
      const custodyServerId = params.requesterSessionCustodyServerId ?? params.serverId;
      const attribution = params.readTrackedSessionAttribution(authority.sessionId);
      const isCustodyCurrent = async () => !authority.signal?.aborted
        && params.isRuntimeCurrent() && await isCurrent()
        && sameStoredCredentials(credentials, await readStoredCredentialsForServerId(custodyServerId))
        && isDeepStrictEqual(origin, await params.resolveCurrentMachineExecutionOriginContext?.(authority.signal));
      const custody = await readOrdinaryRequesterSessionAccountCustodyForHost({
        happyHomeDir: configuration.happyHomeDir, serverId: custodyServerId, serverHttpBaseUrl,
        sessionId: sessionActionOrigin.caller.sessionId, machineId: params.machineId,
        hostHomeServerIdentityId: origin.serverIdentityId, sessionCustodianAccountId: params.externalActionAccountId,
        credentials, attribution,
        isCurrent: isCustodyCurrent, ...(authority.signal ? { signal: authority.signal } : {}),
      });
      authorization = custody ? await projectRequesterAccountActionAuthorization({ authorization,
        serverIdentityId: origin.serverIdentityId, bootstrap: custody,
        ...(authority.signal ? { signal: authority.signal } : {}),
      }) : null;
    }
    if (!authorization) return refused('requester_bootstrap', 'requester_account_custody_projection');
    return (await isCurrent())
      ? {
          authorization,
          target,
          originalActionEnvelope: preparedAuthorization.envelope,
          // The Home mint verified this root's Home and installed receiver.
          // Retain its issuer's ingress only when this Session host receives it.
          ...(authorization.binding.machineId === params.machineId
            ? { verifyMachineAdmissionCurrent: isCurrent }
            : {}),
          ...(!requesterRuntime && encryption.settingsVersion !== undefined
            ? { accountSettingsVersion: encryption.settingsVersion }
            : {}),
        }
      : refused('preparation', 'active_session_action');
  };
}
