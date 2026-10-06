import { resolveMachineControlLocalityProof } from '@/session/machineControlLocality';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import type { StoredCredentials } from '@/persistence';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveAvailableAccountSettings } from '@/settings/accountSettings/resolveAvailableAccountSettings';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAuthoritativePluginSlotOccurrence } from '@/plugins/runtime/reload/runtimeLease';
import { resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';
import type {
  AccountApiTokensListActionOutputV1,
  ApprovalExecutionOriginV1,
  PluginSourceCustodyV1,
  SessionAgentSpawnPolicyV1,
} from '@happier-dev/protocol';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { assertNonEscalatingPermissionMode, resolveEffectivePermissionMode } from '@happier-dev/protocol/actions/permissionPrivilege';
import { getActionSpec, resolveActionExecutionPlacementForInput, SignedRootActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { verifyExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';

import type { ResolveExternalActionTarget } from './executeExternalAction';

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type CurrentMachineExecutionOrigin = Readonly<{
  serverIdentityId: string;
  machineId: string;
}>;

async function readCurrentPluginSourceCustody(pluginId: string): Promise<PluginSourceCustodyV1 | null> {
  return readAuthoritativePluginSlotOccurrence(pluginId)?.sourceCustody ?? null;
}

/**
 * Composes the existing Account credential, Home/Machine identity, and
 * external Session-locality owners for durable Action replay. Unknown owner
 * state is stale: this adapter never substitutes the approving caller.
 */
export function createDaemonApprovalExecutionOriginCurrentness(input: Readonly<{
  accountId: string;
  machineId: string;
  /** Local profile identifier that owns routing to the configured Home. */
  serverId: string;
  resolveCurrentMachineExecutionOriginContext: (
    signal?: AbortSignal,
  ) => Promise<CurrentMachineExecutionOrigin | null>;
  resolveTarget: ResolveExternalActionTarget;
  listAccountApiTokens: (
    signal?: AbortSignal,
  ) => Promise<AccountApiTokensListActionOutputV1>;
  externalActionMachinePublicKey?: string | Uint8Array;
  verifyExternalExecutionAuthorization?: (input: Readonly<{
    authorization: NonNullable<ApprovalExecutionOriginV1['externalActionExecutionAuthorization']>;
    effectActionId: string;
    target: NonNullable<ApprovalExecutionOriginV1['target']>;
    signal?: AbortSignal;
  }>) => Promise<boolean>;
  resolveCurrentPluginSourceCustody?: (pluginId: string) => Promise<PluginSourceCustodyV1 | null>;
  isAutomationRunCurrent?: (caller: Extract<
    ApprovalExecutionOriginV1['caller'],
    Readonly<{ kind: 'automationRun' }>
  >) => Promise<boolean> | boolean;
  /** Reuses the tracked Session authority owner; a target lookup is not caller proof. */
  isSessionCallerCurrent?: (input: Readonly<{
    caller: Extract<ApprovalExecutionOriginV1['caller'], Readonly<{ kind: 'session' }>>;
    signal?: AbortSignal;
  }>) => Promise<boolean> | boolean;
  /**
   * The live Workflow admission owner's own accepted-authorization currentness
   * check, reused verbatim for replay. Its parameter shape is the daemon
   * Workflow runtime's `WorkflowAcceptedAuthorizationCurrentness`, so the same
   * function answers both the live and the replayed question rather than a
   * second principal recheck growing beside it.
   */
  isWorkflowRunAuthorizationCurrent?: (input: Readonly<{
    authorization: Extract<
      ApprovalExecutionOriginV1['caller'],
      Readonly<{ kind: 'workflowRun' }>
    >['authorization'];
    signal?: AbortSignal;
  }>) => Promise<boolean> | boolean;
  resolveCurrentPermissionMode?: (
    origin: ApprovalExecutionOriginV1,
    signal?: AbortSignal,
  ) => Promise<string | null>;
  resolveCurrentSessionAgentSpawnPolicyV1?: (
    origin: ApprovalExecutionOriginV1,
    signal?: AbortSignal,
  ) => Promise<SessionAgentSpawnPolicyV1 | null>;
  now?: () => number;
}>): ((args: Readonly<{
  origin: ApprovalExecutionOriginV1;
  request?: Parameters<NonNullable<ActionExecutorDeps['isApprovalExecutionOriginCurrent']>>[0]['request'];
  signal?: AbortSignal;
}>) => Promise<boolean>) {
  const now = input.now ?? Date.now;
  return async ({ origin, request, signal }) => {
    try {
      // Descriptive PAT ids from legacy API approvals are never sufficient to
      // begin replay currentness checks. They lack the signed exact invocation.
      if (
        origin.surface === 'api'
        && origin.credentialId !== undefined
        && !origin.externalActionExecutionAuthorization
      ) return false;
      const currentMachineOrigin = await input.resolveCurrentMachineExecutionOriginContext(signal);
      if (
        !currentMachineOrigin
        || currentMachineOrigin.machineId !== input.machineId
        || (origin.serverIdentityId !== undefined
          ? currentMachineOrigin.serverIdentityId !== origin.serverIdentityId
          : origin.serverId !== input.serverId)
      ) return false;
      const externalAuthorization = origin.externalActionExecutionAuthorization;
      if (externalAuthorization) {
        if (
          !request
          || request.v !== 2
          || !origin.externalActionInputSignature
          || !origin.target
          || !input.externalActionMachinePublicKey
          || !input.verifyExternalExecutionAuthorization
          || origin.surface !== 'api'
          || (origin.caller.kind !== 'host' && origin.caller.kind !== 'plugin')
          || origin.serverIdentityId !== externalAuthorization.binding.serverIdentityId
          || origin.accountId !== input.accountId
          || origin.accountId !== externalAuthorization.binding.accountId
          || origin.principalId !== externalAuthorization.binding.principalId
          || origin.credentialId !== externalAuthorization.binding.credentialId
          || origin.machineId !== input.machineId
          || origin.machineId !== externalAuthorization.binding.machineId
          || origin.requestId !== externalAuthorization.binding.requestId
          || !verifyExternalActionApprovalInputV1({
            authorizationToken: externalAuthorization.token,
            actionId: origin.actionId,
            target: origin.target,
            input: request.actionArgs,
            publicKey: input.externalActionMachinePublicKey,
            signature: origin.externalActionInputSignature,
          })
        ) return false;
        if (!await input.verifyExternalExecutionAuthorization({
          authorization: externalAuthorization,
          effectActionId: origin.actionId,
          target: origin.target,
          ...(signal ? { signal } : {}),
        })) return false;
        if (origin.caller.kind === 'plugin') {
          const sourceCustody = await (
            input.resolveCurrentPluginSourceCustody
            ?? readCurrentPluginSourceCustody
          )(origin.caller.pluginId);
          return sourceCustody !== null
            && pluginSourceCustodyV1Equal(origin.caller.sourceCustody, sourceCustody);
        }
        return true;
      }
      if (
        (origin.accountId !== undefined && origin.accountId !== input.accountId)
        || (origin.machineId !== undefined && origin.machineId !== input.machineId)
      ) {
        return false;
      }

      const target = origin.target
        ?? (origin.sessionId
          ? { kind: 'session' as const, sessionId: origin.sessionId }
          : origin.machineId
            ? { kind: 'machine' as const, machineId: origin.machineId }
            : undefined);
      if (target) {
        const signedRootActionId = SignedRootActionIdSchema.safeParse(origin.actionId);
        if (!signedRootActionId.success) return false;
        const currentTarget = await input.resolveTarget({
          actionId: signedRootActionId.data,
          target,
          currentMachineId: input.machineId,
          ...(signal ? { signal } : {}),
        });
        if (!currentTarget) return false;
      }

      if (origin.caller.kind === 'plugin') {
        const sourceCustody = await (
          input.resolveCurrentPluginSourceCustody
          ?? readCurrentPluginSourceCustody
        )(origin.caller.pluginId);
        if (!sourceCustody) return false;
        if (!pluginSourceCustodyV1Equal(origin.caller.sourceCustody, sourceCustody)) {
          return false;
        }
      }

      if (origin.caller.kind === 'automationRun') {
        if (!input.isAutomationRunCurrent) return false;
        if (!await input.isAutomationRunCurrent(origin.caller)) return false;
      }

      if (origin.caller.kind === 'session') {
        if (!input.isSessionCallerCurrent) return false;
        if (!await input.isSessionCallerCurrent({ caller: origin.caller,
          ...(signal ? { signal } : {}) })) return false;
      }

      // A Workflow Run's durable origin carries the exact accepted
      // authorization its live admission already opened, so replay rechecks the
      // same principal through the same owner. Without that owner the principal
      // cannot be rechecked at all, which fails closed exactly like the
      // Automation arm beside it.
      if (origin.caller.kind === 'workflowRun') {
        if (!input.isWorkflowRunAuthorizationCurrent) return false;
        if (!await input.isWorkflowRunAuthorizationCurrent({
          authorization: origin.caller.authorization,
          ...(signal ? { signal } : {}),
        })) return false;
      }

      if (origin.callerPermissionMode !== undefined || origin.causalPermissionAuthority !== undefined) {
        if (origin.causalPermissionAuthority && !origin.callerPermissionMode) return false;
        if (origin.callerPermissionMode !== undefined) {
          if (origin.callerPermissionMode === null) return false;
          // A Workflow Run has no Session whose mode can change: its current
          // permission is the immutable ceiling of the accepted authorization
          // that the Workflow owner has just rechecked above, exactly the mode
          // its live admission stamped as caller permission.
          const currentPermissionMode = origin.caller.kind === 'workflowRun'
            ? origin.caller.authorization.admittedPermissionCeiling
            : input.resolveCurrentPermissionMode
              ? await input.resolveCurrentPermissionMode(origin, signal)
              : null;
          if (!currentPermissionMode) return false;
          if (origin.causalPermissionAuthority) {
            const admittedPermissionCeiling = origin.causalPermissionAuthority.admittedPermissionCeiling;
            const approved = resolveEffectivePermissionMode({
              currentMode: origin.callerPermissionMode,
              admittedPermissionCeiling,
            });
            const current = resolveEffectivePermissionMode({
              currentMode: currentPermissionMode,
              admittedPermissionCeiling,
            });
            if (!approved.ok || !current.ok || !assertNonEscalatingPermissionMode({
              requestedMode: approved.effectiveMode,
              callerMode: current.effectiveMode,
            }).ok) return false;
          } else if (!assertNonEscalatingPermissionMode({
            requestedMode: origin.callerPermissionMode,
            callerMode: currentPermissionMode,
          }).ok) return false;
        }
      }

      if (
        origin.surface === 'agent'
        && origin.actionId === 'session.spawn_new'
        && origin.sessionAgentSpawnPolicyV1 === undefined
      ) return false;
      if (origin.sessionAgentSpawnPolicyV1 !== undefined) {
        if (!input.resolveCurrentSessionAgentSpawnPolicyV1) return false;
        const currentPolicy = await input.resolveCurrentSessionAgentSpawnPolicyV1(origin, signal);
        if (!currentPolicy || !doesCurrentSpawnPolicyAdmitApprovedPolicy({
          approved: origin.sessionAgentSpawnPolicyV1,
          current: currentPolicy,
        })) return false;
      }

      // This authenticated Account-owned read is also the current Account
      // eligibility proof for host/plugin callers that have no PAT id.
      const tokenList = await input.listAccountApiTokens(signal);
      if (origin.credentialId === undefined) return true;
      if (
        origin.accountId !== input.accountId
        || origin.principalId !== input.accountId
      ) {
        return false;
      }
      const token = tokenList.tokens.find((candidate) => candidate.tokenId === origin.credentialId);
      if (!token) return false;
      if (token.expiresAt !== null && Date.parse(token.expiresAt) <= now()) return false;
      return true;
    } catch {
      return false;
    }
  };
}

const SPAWN_POLICY_ALLOWANCE_FIELDS = [
  'allowCustomDirectory',
  'allowCrossMachine',
  'allowBackendTargetOverride',
  'allowModelOverride',
  'allowPermissionModeOverride',
  'allowAgentModeOverride',
  'allowConfigOptionOverrides',
  'allowProfileOverride',
  'allowConnectedServicesOverride',
  'allowMcpSelectionOverride',
  'allowTranscriptStorageOverride',
] as const satisfies readonly (keyof SessionAgentSpawnPolicyV1)[];

function doesCurrentSpawnPolicyAdmitApprovedPolicy(input: Readonly<{
  approved: SessionAgentSpawnPolicyV1;
  current: SessionAgentSpawnPolicyV1;
}>): boolean {
  for (const field of SPAWN_POLICY_ALLOWANCE_FIELDS) {
    if (input.approved[field] && !input.current[field]) return false;
  }
  if (input.approved.permissionCeiling === null) {
    return input.current.permissionCeiling === null;
  }
  if (input.current.permissionCeiling === null) return true;
  const resolved = resolveEffectivePermissionMode({
    currentMode: input.approved.permissionCeiling,
    admittedPermissionCeiling: input.current.permissionCeiling,
  });
  return resolved.ok && resolved.effectiveMode === input.approved.permissionCeiling;
}

/** Canonical production composition for every credential-backed Action executor. */
export function createDaemonApprovalExecutionOriginCurrentnessFromCredentials(input: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  serverId: string;
  serverApiUrl: string;
  isAutomationRunCurrent?: Parameters<typeof createDaemonApprovalExecutionOriginCurrentness>[0]['isAutomationRunCurrent'];
  isSessionCallerCurrent?: Parameters<typeof createDaemonApprovalExecutionOriginCurrentness>[0]['isSessionCallerCurrent'];
  isWorkflowRunAuthorizationCurrent?: Parameters<typeof createDaemonApprovalExecutionOriginCurrentness>[0]['isWorkflowRunAuthorizationCurrent'];
  resolveCurrentPermissionMode?: Parameters<typeof createDaemonApprovalExecutionOriginCurrentness>[0]['resolveCurrentPermissionMode'];
  resolveCurrentSessionAgentSpawnPolicyV1?: Parameters<typeof createDaemonApprovalExecutionOriginCurrentness>[0]['resolveCurrentSessionAgentSpawnPolicyV1'];
  resolveServerFeaturesSnapshot?: () =>
    | CliServerFeaturesSnapshot
    | undefined
    | Promise<CliServerFeaturesSnapshot | undefined>;
}>): ReturnType<typeof createDaemonApprovalExecutionOriginCurrentness> | undefined {
  const accountId = readAccountIdFromToken(input.credentials.token);
  if (!accountId) return undefined;
  const accountServerActionDeps = createAccountServerActionDeps({
    token: input.credentials.token,
    serverId: input.serverId,
    serverHttpBaseUrl: input.serverApiUrl,
    ...(input.resolveServerFeaturesSnapshot
      ? { resolveServerFeaturesSnapshot: input.resolveServerFeaturesSnapshot }
      : {}),
  });
  const installationIdentity = readInstallationIdentityIfExistsSync();
  const listAccountApiTokensAction = accountServerActionDeps.accountApiTokensListAction;
  if (!listAccountApiTokensAction) return undefined;

  const readCurrentSession = async (origin: ApprovalExecutionOriginV1, signal?: AbortSignal) => {
    const sessionId = origin.caller.kind === 'session' ? origin.caller.sessionId : origin.sessionId;
    if (!sessionId) return null;
    const serverFeaturesSnapshot = await input.resolveServerFeaturesSnapshot?.();
    const transport = await resolveSessionTransportContext({
      credentials: input.credentials,
      idOrPrefix: sessionId,
      ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
      ...(signal ? { signal } : {}),
    });
    return transport.ok && transport.sessionId === sessionId && transport.rawSession.id === sessionId
      ? transport : null;
  };
  const checker = createDaemonApprovalExecutionOriginCurrentness({
    accountId,
    machineId: input.machineId,
    serverId: input.serverId,
    resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
      serverUrl: input.serverApiUrl,
      resolveCurrentMachineId: () => input.machineId,
    }),
    resolveTarget: createDaemonExternalActionTargetResolver({
      credentials: input.credentials,
      serverApiUrl: input.serverApiUrl,
      ...(input.resolveServerFeaturesSnapshot
        ? { resolveServerFeaturesSnapshot: input.resolveServerFeaturesSnapshot }
        : {}),
    }),
    listAccountApiTokens: async (signal) => {
      const result = await listAccountApiTokensAction({
        input: {},
        context: { surface: 'rpc', authority: 'account_automation', serverId: input.serverId },
        ...(signal ? { signal } : {}),
      });
      if ('ok' in result) throw new Error(result.errorCode);
      return result;
    },
    ...(installationIdentity
      ? {
          externalActionMachinePublicKey: installationIdentity.publicKey,
          verifyExternalExecutionAuthorization: async ({ authorization, effectActionId, target, signal }) =>
            await verifyExternalActionExecutionAuthorizationCurrent({
              authorization,
              effectActionId,
              target,
              privateKey: installationIdentity.privateKey,
              installationId: installationIdentity.installationId,
              serverHttpBaseUrl: input.serverApiUrl,
              ...(signal ? { signal } : {}),
            }),
        }
      : {}),
    ...(input.isAutomationRunCurrent ? { isAutomationRunCurrent: input.isAutomationRunCurrent } : {}),
    ...(input.isSessionCallerCurrent ? { isSessionCallerCurrent: input.isSessionCallerCurrent } : {}),
    ...(input.isWorkflowRunAuthorizationCurrent
      ? { isWorkflowRunAuthorizationCurrent: input.isWorkflowRunAuthorizationCurrent }
      : {}),
    resolveCurrentPermissionMode: input.resolveCurrentPermissionMode ?? (async (origin, signal) => {
      const transport = await readCurrentSession(origin, signal);
      if (!transport) return null;
      const metadata = tryDecryptSessionOwnerMetadataView({
        credentials: input.credentials,
        accountEncryptionMode: transport.accountEncryptionCurrentness.mode,
        rawSession: transport.rawSession,
      });
      return resolvePermissionIntentFromSessionMetadata(metadata)?.intent ?? null;
    }),
    resolveCurrentSessionAgentSpawnPolicyV1: input.resolveCurrentSessionAgentSpawnPolicyV1 ?? (async () => {
      const settings = await resolveAvailableAccountSettings({ credentials: input.credentials });
      return settings?.sessionAgentSpawnPolicyV1 ?? null;
    }),
  });
  return (args) => runWithServerHttpBaseUrl(input.serverApiUrl, () => checker(args));
}

function readSessionLocality(
  transport: Extract<Awaited<ReturnType<typeof resolveSessionTransportContext>>, { ok: true }>,
  credentials: StoredCredentials,
): Readonly<{
  machineId: string | null;
  host: string | null;
  homeDir: string | null;
}> | null {
  const metadata = tryDecryptSessionOwnerMetadataView({
    credentials,
    accountEncryptionMode: transport.accountEncryptionCurrentness.mode,
    rawSession: transport.rawSession,
  });
  // An unreadable private owner envelope is not permission to trust a raw
  // projection. Layout-0 owner metadata retains the incumbent row fallback.
  if (!metadata && transport.rawSession.metadataLayoutVersion === 1) return null;
  const session = transport.rawSession;
  const legacyRowField = (field: string) => session.metadataLayoutVersion === 1
    ? null : readNonEmptyString(Reflect.get(session, field));
  return {
    // New rows keep owner-locality in encrypted metadata. The raw projection is
    // retained only for older rows that have no readable metadata value.
    machineId: readNonEmptyString(metadata?.machineId)
      ?? legacyRowField('machineId'),
    host: readNonEmptyString(metadata?.host)
      ?? legacyRowField('host'),
    homeDir: readNonEmptyString(metadata?.homeDir)
      ?? legacyRowField('homeDir'),
  };
}

/**
 * Rechecks the effect target through the existing Account Session owner. Only
 * machine/session-placed execution also requires daemon locality; Account
 * Actions may operate on an accessible Session on another machine.
 */
export function createDaemonExternalActionTargetResolver(input: Readonly<{
  credentials: StoredCredentials;
  serverApiUrl?: string;
  resolveServerFeaturesSnapshot?: () =>
    | CliServerFeaturesSnapshot
    | undefined
    | Promise<CliServerFeaturesSnapshot | undefined>;
  currentMachineHost?: string | null;
  currentMachineHomeDir?: string | null;
}>): ResolveExternalActionTarget {
  return async ({ actionId, actionInput, target, currentMachineId, signal }) => {
    if (!target) {
      return { kind: 'machine', machineId: currentMachineId };
    }

    if (target.kind === 'machine') {
      return target.machineId === currentMachineId ? target : null;
    }

    const serverFeaturesSnapshot = await input.resolveServerFeaturesSnapshot?.();
    if (resolveActionExecutionPlacementForInput(getActionSpec(actionId), actionInput) === 'account') {
      const session = await fetchSessionById({
        token: input.credentials.token,
        sessionId: target.sessionId,
        ...(input.serverApiUrl ? { serverUrl: input.serverApiUrl } : {}),
        ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
        ...(signal ? { signal } : {}),
      });
      return session?.id === target.sessionId ? target : null;
    }
    const resolveTransport = () => resolveSessionTransportContext({
      credentials: input.credentials, idOrPrefix: target.sessionId,
      ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
      ...(signal ? { signal } : {}),
    });
    const transport = input.serverApiUrl
      ? await runWithServerHttpBaseUrl(input.serverApiUrl, resolveTransport)
      : await resolveTransport();
    if (!transport.ok || transport.sessionId !== target.sessionId || transport.rawSession.id !== target.sessionId) return null;
    const localityRecord = readSessionLocality(transport, input.credentials);
    if (!localityRecord?.machineId) return null;

    const locality = await resolveMachineControlLocalityProof({
      sessionMachineId: localityRecord.machineId,
      currentMachineId,
      sessionHost: localityRecord.host,
      sessionHomeDir: localityRecord.homeDir,
      ...(input.currentMachineHost ? { currentMachineHost: input.currentMachineHost } : {}),
      ...(input.currentMachineHomeDir
        ? { currentMachineHomeDir: input.currentMachineHomeDir }
        : {}),
      credentials: { token: input.credentials.token },
    });
    return locality ? target : null;
  };
}
