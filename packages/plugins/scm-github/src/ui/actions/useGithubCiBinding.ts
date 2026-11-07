import { useMemo } from 'react';
import type { JsonValue, PluginContributionRef } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';
import { createForgeCiAdapterV1 } from '@happier-dev/forge-ci/runtime';
import {
  useForgeCiReadsV1,
  type ForgeCiBindingV1,
} from '@happier-dev/forge-ci/ui';
import { usePluginHostApi, useSurfaceContext } from '@happier-dev/plugin-ui';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../../observations/githubProviderContracts.js';
import {
  GITHUB_ACTIONS_ACTIVE_POLL_INTERVAL_MS,
  GITHUB_CI_ACTION_REFS_V1,
} from './model.js';

const GITHUB_FORGE_NAME = 'GitHub';

/**
 * The one GitHub CI binding for a mounted surface (Actions page, PR Checks drill-down, rail, Overview): the single
 * L02 adapter over this plugin's CI Actions, invoked through the ordinary host Action path as the present person,
 * and the shared read owner leased from the host's ephemeral scope. Every shared CI view takes this object; no
 * surface constructs a second adapter or read owner.
 */
export function useGithubCiBindingV1(
  /** Exact operands for the host's declared-purpose read-authority admission. */
  _repository: ScmHostingRepositoryIdentityV1 | null = null,
  options: Readonly<{
    /** The mounted renderer's existing cancellation lifetime. */
    signal?: AbortSignal;
    /** Account disclosure for repair and presentation; it does not select the native Action's credential. */
    account?: ConnectedAccountRef | null;
    accountLabel?: string | null;
    machineLabel?: string | null;
    fix?: ForgeCiBindingV1['fix'];
  }> = {},
): ForgeCiBindingV1 {
  const host = usePluginHostApi();
  const { target } = useSurfaceContext();
  const adapter = useMemo(
    () =>
      createForgeCiAdapterV1({
        actionRefs: GITHUB_CI_ACTION_REFS_V1,
        invoke: (
          action: PluginContributionRef,
          input: JsonValue,
          invocation?: Readonly<{ signal?: AbortSignal }>,
        ) =>
          host.executeAction(action, input, invocation),
        activeRunPollIntervalMs: GITHUB_ACTIONS_ACTIVE_POLL_INTERVAL_MS,
      }),
    [host],
  );
  // Separate supplied account disclosures, without treating them as credential
  // admission. The Action owns its actual purpose binding and native fallback.
  const accountKey = options.account
    ? JSON.stringify([options.account.service.pluginId, options.account.service.localId, options.account.accountId])
    : 'default';
  const readAuthority = useMemo(() => _repository === null ? null : ({ readAuthority: {
    consumer: GITHUB_CI_ACTION_REFS_V1.listRuns!,
    purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
    input: { repository: _repository, filters: {} },
  } }), [_repository?.kind, _repository?.deployment, _repository?.repository]);
  // Session purpose bindings can differ before either changes. The admitted
  // surface target is part of the invocation scope, not a credential selector.
  const targetKey = target.kind === 'session' ? ['session', target.sessionId]
    : target.kind === 'project' ? ['project', target.projectKey] : [target.kind];
  const reads = useForgeCiReadsV1({
    adapter,
    scopeKey: `github/${JSON.stringify([accountKey, targetKey, readAuthority])}`,
    readAuthority,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return useMemo<ForgeCiBindingV1>(
    () => ({
      reads,
      adapter,
      actionRefs: GITHUB_CI_ACTION_REFS_V1,
      about: {
        forgeName: GITHUB_FORGE_NAME,
        accountLabel: options.accountLabel ?? null,
        machineLabel: options.machineLabel ?? null,
      },
      account: options.account ?? null,
      ...(options.fix === undefined ? {} : { fix: options.fix }),
    }),
    [
      reads,
      adapter,
      options.account,
      options.accountLabel,
      options.machineLabel,
      options.fix,
    ],
  );
}

/** The read owner alone, for surfaces that only list (the runs Collection's data model). */
export function useGithubCiReadsV1(
  options?: Parameters<typeof useGithubCiBindingV1>[0],
) {
  return useGithubCiBindingV1(options).reads;
}
