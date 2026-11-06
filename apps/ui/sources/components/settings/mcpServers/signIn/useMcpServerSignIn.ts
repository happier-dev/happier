import * as React from 'react';
import { Platform } from 'react-native';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import {
  MCP_OAUTH_CALLBACK_URL_V1,
  type McpOAuthClientRegistrationV1,
} from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';
import type { ConnectedAccountRevokedResponseV1Schema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { getStorage } from '@/sync/domains/state/storageStore';
import { runConnectedAccountAuthenticationAction } from '@/sync/ops/connectedAccounts/connectedAccountDaemon';
import { readMcpOAuthOpenerMessage } from '@/sync/ops/connectedAccounts/mcpOAuthCallback';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { normalizeInternalReturnPath } from '@/utils/path/routeUtils';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

import type { McpServerSignInFact } from '../status/mcpServerStatus';
import { aggregateMcpMachineOnline, findMcpSignInGrant, mcpSignInGrantView, mcpSignInFact, type McpSignInView } from './mcpSignInGrantView';
import { useMcpSignInGrantDiagnostics } from './useMcpSignInGrantDiagnostics';
export { findMcpSignInGrant, mcpSignInGrantIdentity, mcpSignInGrantView, mcpSignInFact, type McpSignInView } from './mcpSignInGrantView';

/** A machine as the sign-in needs it: REACH's presence and a name to say where it finishes. */
export type McpSignInMachine = Readonly<{
  machineId: string;
  name: string;
  online: boolean | null;
}>;

export type McpSignInCompletion = Readonly<{
  code: string;
  state: string;
  iss?: string;
}>;

export type McpServerSignIn = Readonly<{
  view: McpSignInView | null;
  /** The same state in the status owner's vocabulary (banner, rail chip). */
  fact: McpServerSignInFact;
  start: (options?: Readonly<{ stepUp?: boolean; client?: McpOAuthClientRegistrationV1 }>) => Promise<void>;
  cancel: () => Promise<void>;
  complete: (completion: McpSignInCompletion) => Promise<boolean>;
  signOut: () => Promise<boolean>;
  busy: boolean;
}>;

type Attempt = Readonly<{
  attemptId: string;
  machineId: string;
  authorizationUrl: string;
  expiresAtMs: number;
  clientRegistration?: 'not_needed';
}>;
type Local =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'starting'; baseline: string | null }>
  | Readonly<{ kind: 'signing'; attempt: Attempt; baseline: string | null }>
  | Readonly<{ kind: 'finishing'; attempt: Attempt; baseline: string | null }>
  | Readonly<{
      kind: 'failed';
      state: 'did_not_finish' | 'no_machine_online' | 'client_refused' | 'invalid_client';
      baseline: string | null;
    }>;

const IDLE: Local = { kind: 'idle' };

function failureState(
  code: string | undefined,
): 'did_not_finish' | 'no_machine_online' | 'client_refused' | 'invalid_client' {
  if (code === 'no_machine_online') return 'no_machine_online';
  if (code === 'client_refused') return 'client_refused';
  if (code === 'invalid_client') return 'invalid_client';
  return 'did_not_finish';
}

/**
 * One OAuth MCP server's sign-in (T2): the Account's grant (synced with the profile, so every device sees
 * it land) plus this page's own attempt. Start, cancel, finish (an opener message from the callback page,
 * or a pasted answer) and sign out all go through the existing Actions; the daemon owns PKCE, state and
 * issuer checks. The grant is the truth: an attempt ends when the grant it was waiting for changes.
 */
export function useMcpServerSignIn(
  server: McpServerCatalogEntryV1 | null,
  machines: readonly McpSignInMachine[],
  options?: Readonly<{ returnTo?: string; scope?: AccountSettingsScope | null }>,
): McpServerSignIn {
  const signsIn =
    server !== null && server.transport !== 'stdio' && server.remote?.auth?.kind === 'oauth';
  const activeSettingsScope = useAccountSettingsScope();
  const settingsScope = options?.scope === undefined ? activeSettingsScope : options.scope;
  const homeId = settingsScope?.serverId;
  const accountId = settingsScope?.accountId;
  const scope = React.useMemo(
    () => (homeId && accountId ? { serverId: homeId, accountId } : null),
    [homeId, accountId],
  );
  const execution = useMountedActionExecution(scope);
  const execute = execution.execute;
  const profiles = getStorage()((state) => areServerAccountScopesEqual(scope, state.profileScope) ? state.profile.connectedAccountsV4 : null);
  const grant = server ? findMcpSignInGrant(profiles, server.id) : null;
  const diagnostics = useMcpSignInGrantDiagnostics(profiles, scope, machines.find(machine => machine.online)?.machineId ?? machines[0]?.machineId ?? null);
  // A configuration CAS can precede a provider refusal. Only a new credential
  // receipt, not configuration or health changes, proves that this flow connected.
  const fingerprint = grant ? grant.credentialRevision ?? '' : null;
  const targetKey = JSON.stringify([scope?.serverId, scope?.accountId, server?.id]);
  const target = React.useMemo(() => ({ key: targetKey }), [targetKey]);
  const [localState, setLocalState] = React.useState<Readonly<{ target: typeof target; value: Local }>>({ target, value: IDLE });
  const local = localState.target === target ? localState.value : IDLE;
  const currentLocal = React.useRef({ target, value: local });
  currentLocal.current = { target, value: local };
  const setLocal = React.useCallback((update: React.SetStateAction<Local>) => {
    if (currentLocal.current.target !== target) return;
    const current = currentLocal.current.value;
    const value = typeof update === 'function' ? update(current) : update;
    if (value === current) return;
    // Claim a transition before React renders: callback and paste can arrive in the same turn.
    const next = { target, value };
    currentLocal.current = next;
    setLocalState(next);
  }, [target]);
  const isLocalCurrent = React.useCallback((value: Local) =>
    currentLocal.current.target === target && currentLocal.current.value === value, [target]);
  const [signingOut, setSigningOut] = React.useState(false);
  const [revocation, setRevocation] = React.useState<Readonly<{
    key: string;
    receipt: ReturnType<typeof ConnectedAccountRevokedResponseV1Schema.parse>;
    credentialRevision: NonNullable<typeof grant>['credentialRevision'];
  }> | null>(null);
  const anyOnline = aggregateMcpMachineOnline(machines);

  // An attempt ends when its connected credential lands (from this page, the callback page or another device).
  React.useEffect(() => {
    if (
      local.kind !== 'idle' &&
      fingerprint !== local.baseline &&
      grant?.status === 'connected'
    ) {
      setLocal(IDLE);
    }
  }, [fingerprint, grant?.status, local, setLocal]);

  // The authorization link has a lifetime; past it the attempt didn't finish.
  const signingAttempt = local.kind === 'signing' ? local.attempt : null;
  React.useEffect(() => {
    if (!signingAttempt) return;
    const remaining = signingAttempt.expiresAtMs - Date.now();
    const timer = setTimeout(
      () =>
        setLocal((current) =>
          current.kind === 'signing' && current.attempt === signingAttempt
            ? { kind: 'failed', state: 'did_not_finish', baseline: current.baseline }
            : current,
        ),
      Math.max(0, remaining),
    );
    return () => clearTimeout(timer);
  }, [signingAttempt, setLocal]);

  const complete = React.useCallback(
    async (completion: McpSignInCompletion): Promise<boolean> => {
      if (local.kind !== 'signing' || !scope || !isLocalCurrent(local)) return false;
      const { attempt, baseline } = local;
      if (completion.state.slice(0, completion.state.lastIndexOf('.')) !== attempt.attemptId) return false;
      const finishing: Local = { kind: 'finishing', attempt, baseline };
      setLocal(finishing);
      const fail = (code?: string) => setLocal(current => current === finishing
        ? { kind: 'failed', state: failureState(code), baseline } : current);
      try {
        const response = await runConnectedAccountAuthenticationAction({
          serverId: scope.serverId,
          expectedAccountId: scope.accountId,
          machineId: attempt.machineId,
          executeAction: execute,
          command: {
            operation: 'completeOAuth',
            attemptId: attempt.attemptId,
            completion: {
              code: completion.code,
              state: completion.state,
              callbackUrl: MCP_OAUTH_CALLBACK_URL_V1,
              ...(completion.iss === undefined ? {} : { iss: completion.iss }),
            },
          },
        });
        if (response.status === 'connected') return true;
        fail('code' in response ? response.code : undefined);
        return false;
      } catch (cause) {
        fail(cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined);
        return false;
      }
    },
    [execute, isLocalCurrent, local, scope, setLocal],
  );

  // The callback page hands the answer back to the page that opened it, from app.happier.dev only.
  const completeRef = React.useRef(complete);
  completeRef.current = complete;
  const listening = local.kind === 'signing' ? local.attempt.attemptId : null;
  React.useEffect(() => {
    if (!listening || Platform.OS !== 'web') return;
    const target = globalThis as unknown as {
      addEventListener?: Window['addEventListener'];
      removeEventListener?: Window['removeEventListener'];
    };
    if (!target.addEventListener) return;
    const onMessage = (event: MessageEvent) => {
      const message = readMcpOAuthOpenerMessage(event);
      if (!message) return;
      void completeRef.current(message);
    };
    target.addEventListener('message', onMessage);
    return () => target.removeEventListener?.('message', onMessage);
  }, [listening]);

  const start = React.useCallback(
    async (startOptions?: Readonly<{ stepUp?: boolean; client?: McpOAuthClientRegistrationV1 }>) => {
      if (!server || !scope || currentLocal.current.target !== target) return;
      const starting: Local = { kind: 'starting', baseline: fingerprint };
      setLocal(starting);
      const result = await execute('mcp.servers.signIn.start', {
        serverId: server.id,
        ...(startOptions?.stepUp ? { stepUp: true } : {}),
        ...(startOptions?.client !== undefined ? { client: startOptions.client } : {}),
      });
      if (!isLocalCurrent(starting) || !execution.isCurrent()) return;
      if (!result.ok) {
        setLocal({ kind: 'failed', state: failureState(result.errorCode), baseline: fingerprint });
        return;
      }
      const parsed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1[
        'mcp.servers.signIn.start'
      ].safeParse(result.result);
      if (!parsed.success) {
        setLocal({ kind: 'failed', state: 'did_not_finish', baseline: fingerprint });
        return;
      }
      const signing: Local = {
        kind: 'signing',
        attempt: parsed.data,
        baseline: fingerprint,
      };
      setLocal(signing);
      const returnTo = normalizeInternalReturnPath(options?.returnTo);
      if (returnTo) {
        // Reuse the generic external-connect continuation; OAuth state remains daemon-owned.
        const retained = await TokenStorage.setPendingExternalConnect({ provider: `mcp:${parsed.data.attemptId}`,
          returnTo, serverId: scope.serverId, serverUrl: getServerProfileById(scope.serverId)?.serverUrl });
        if (!isLocalCurrent(signing) || !execution.isCurrent()) return;
        if (!retained) { setLocal({ kind: 'failed', state: 'did_not_finish', baseline: fingerprint }); return; }
      }
      await openExternalUrl(parsed.data.authorizationUrl).catch(() => false);
    },
    [execute, execution.isCurrent, fingerprint, isLocalCurrent, server, scope, options?.returnTo, target, setLocal],
  );

  const cancel = React.useCallback(async () => {
    if (!isLocalCurrent(local)) return;
    const attempt = local.kind === 'signing' ? local.attempt : null;
    setLocal(IDLE);
    if (!attempt || !scope) return;
    await runConnectedAccountAuthenticationAction({
      serverId: scope.serverId,
      expectedAccountId: scope.accountId,
      machineId: attempt.machineId,
      executeAction: execute,
      command: { operation: 'cancel', attemptId: attempt.attemptId },
    }).catch(() => undefined);
  }, [execute, isLocalCurrent, local, scope, setLocal]);

  const signOut = React.useCallback(async (): Promise<boolean> => {
    const machine = machines.find((candidate) => candidate.online);
    if (!grant || !machine) return false;
    setSigningOut(true);
    try {
      const result = await execute('connectedServices.accounts.revoke', {
        machineId: machine.machineId,
        account: grant.ref,
        cleanupGroupReferences: true,
        ...(grant.revisionSemantics === 'revisioned'
          ? { expectedCredentialRevision: grant.credentialRevision }
          : {}),
      });
      // A declined press or retired page is handled without presenting a failed sign-out.
      if (!result.ok && (isActionApprovalDeclinedErrorCode(result.errorCode)
        || result.errorCode === 'action_account_scope_changed')) return true;
      const revoked = result.ok ? CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.accounts.revoke'].safeParse(result.result) : null;
      if (!revoked?.success || revoked.data.status !== 'revoked' || revoked.data.account.accountId !== grant.ref.accountId
        || revoked.data.account.service.pluginId !== grant.ref.service.pluginId || revoked.data.account.service.localId !== grant.ref.service.localId) return false;
      setRevocation({ key: targetKey, receipt: revoked.data, credentialRevision: grant.credentialRevision });
      return true;
    } finally {
      setSigningOut(false);
    }
  }, [execute, grant, machines, targetKey]);

  const view = React.useMemo((): McpSignInView | null => {
    if (!signsIn || !server) return null;
    switch (local.kind) {
      case 'starting':
        return { state: 'starting' };
      case 'signing':
        return {
          state: 'signing',
          authorizationUrl: local.attempt.authorizationUrl,
          expiresAtMs: local.attempt.expiresAtMs,
          ...(local.attempt.clientRegistration ? { clientRegistration: local.attempt.clientRegistration } : {}),
        };
      case 'finishing':
        return {
          state: 'finishing',
          machineName:
            machines.find(
              (machine) => machine.machineId === local.attempt.machineId,
            )?.name ?? local.attempt.machineId,
        };
      case 'failed':
        return { state: local.state };
      case 'idle':
        break;
    }
    return mcpSignInGrantView(server, grant, anyOnline, {
      ...diagnostics[server.id],
      ...(revocation?.key === targetKey && (!grant || grant.credentialRevision === revocation.credentialRevision) ? { revoked: revocation.receipt } : {}),
    });
  }, [anyOnline, diagnostics, grant, local, machines, revocation, server, signsIn, targetKey]);

  const fact = React.useMemo(() => mcpSignInFact(view), [view]);
  return {
    view,
    fact,
    start,
    cancel,
    complete,
    signOut,
    busy: local.kind === 'starting' || signingOut,
  };
}
