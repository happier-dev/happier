import * as React from 'react';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import { resolveMcpServerAdministrationMachineId } from '@/sync/ops/actions/mcpServerAdministrationTarget';
import { isMcpSignInService, type McpSignInGrantDiagnostics } from './mcpSignInGrantView';

type Diagnostics = Readonly<Record<string, McpSignInGrantDiagnostics | undefined>>;
const EMPTY: Diagnostics = Object.freeze({});

/** On-demand safe configuration reads, invalidated by the Connected Account's canonical revisions.
 * No token, new store or polling: all surfaces consume this reader and the ONE grant view.
 */
export function useMcpSignInGrantDiagnostics(profiles: readonly QualifiedConnectedAccountProfileV4[] | null | undefined,
  scope: AccountSettingsScope | null | undefined): Diagnostics {
  const execution = useMountedActionExecution(scope ?? null);
  const { execute, ready } = execution;
  const grants = (profiles ?? []).filter(profile => isMcpSignInService(profile.ref.service));
  const enabled = Boolean(scope && grants.length);
  // Observe the resolved administration Machine, never whole-fleet inventory: another Machine's daemon state or
  // hydration changes nothing here unless it changes which Machine answers. Exact saved targets retain
  // Administration's explicit-request admission; absent preferences keep the same automatic choice as Sign in.
  const subscribeStore = React.useCallback((listener: () => void) => getStorage().subscribe(listener), []);
  const readMachineId = React.useCallback(() => enabled && scope
    ? resolveMcpServerAdministrationMachineId(scope, { intent: 'retry' }) : null, [enabled, scope]);
  const machineId = React.useSyncExternalStore(subscribeStore, readMachineId, readMachineId);
  const key = scope && grants.length > 0 ? JSON.stringify([scope.serverId, scope.accountId, machineId,
    grants.map(grant => [grant.ref.accountId, grant.credentialRevision, grant.configurationRevision])]) : null;
  const inputs = React.useRef({ grants, machineId, isCurrent: execution.isCurrent });
  inputs.current = { grants, machineId, isCurrent: execution.isCurrent };
  const [state, setState] = React.useState<Readonly<{ key: string | null; values: Diagnostics }>>({ key: null, values: EMPTY });

  React.useEffect(() => {
    if (!key || !ready) return;
    const current = inputs.current;
    if (!current.machineId) {
      setState({ key, values: Object.fromEntries(current.grants.map(grant => [grant.ref.accountId, { unavailable: true }])) });
      return;
    }
    const controller = new AbortController();
    void Promise.all(current.grants.map(async grant => {
      const result = await execute('connectedServices.configuration.get', {
        machineId: current.machineId, target: { kind: 'account', account: grant.ref },
      }, { signal: controller.signal }).catch(() => null);
      const parsed = result?.ok ? CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.configuration.get'].safeParse(result.result) : null;
      return [grant.ref.accountId, parsed?.success ? { configuration: parsed.data } : { unavailable: true }] as const;
    })).then(entries => {
      if (!controller.signal.aborted && current.isCurrent()) setState({ key, values: Object.fromEntries(entries) });
    });
    return () => controller.abort();
  }, [execute, key, ready]);
  return key && state.key === key ? state.values : EMPTY;
}
