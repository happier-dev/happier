import * as React from 'react';
import {
  validateDeploySuggestionV1,
  type DeploySuggestionCatalogV1,
} from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';
import { DEFAULT_PROJECT_REPOSITORY_PROVIDER_KIND_V1 } from '@happier-dev/protocol/projects/starters/createV1';
import type { ScmHostingRepositoryDescribePublishTargetsResponse } from '@happier-dev/protocol/scm';
import type { ScmHostingProviderKind } from '@happier-dev/protocol/scm/pullRequests';

import { resolveSourceControlPublishRepositoryRemediation } from '@/components/workspaces/scm/update/resolveSourceControlPublishRepositoryRemediation';
import { readDeploySuggestionCatalog } from '@/execution/llmTasks/suggestDeploySetup';
import { machineScmHostingRepositoryDescribePublishTargets } from '@/sync/ops/scm/machineScm';

import type { NewAppAutoChosen } from './auto/useNewAppAutoSuggestions';

type PublishTarget = Extract<
  ScmHostingRepositoryDescribePublishTargetsResponse,
  { success: true }
>['targets'][number];

/** Where the new repository would go on one forge, as the Machine's SCM owner describes it. */
export type ForgeOwnerFact =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; owner: string; target: PublishTarget }>
  | Readonly<{ kind: 'needsAccount'; providerName: string | null }>
  | Readonly<{ kind: 'unavailable'; providerName: string | null }>;

export type NewAppForge = Readonly<DeploySuggestionCatalogV1['forges'][number]>;

const LOADING: ForgeOwnerFact = Object.freeze({ kind: 'loading' });
const NO_FORGES: readonly NewAppForge[] = Object.freeze([]);

/**
 * Code lives on (journey-deploy F5). The offered forges come from the catalog snapshot (`forges`): a suggested setup
 * keeps only forges its validator still admits with the suggested target; a starter picked by hand reads the same
 * snapshot once and offers every publisher, since no target is chosen yet. Each offered forge is described once while
 * the step is open (where the repository would go, or what it needs); choosing a forge reads and writes nothing.
 */
export function useNewAppForges(
  params: Readonly<{
    serverId: string | null;
    machineId: string | null;
    homeDir: string | null;
    active: boolean;
    suggestion: NewAppAutoChosen | null;
  }>,
) {
  const { serverId, machineId, homeDir, active, suggestion } = params;
  const [ownCatalog, setOwnCatalog] =
    React.useState<DeploySuggestionCatalogV1 | null>(null);
  const catalogRead = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!active || suggestion || !serverId || catalogRead.current === serverId)
      return;
    catalogRead.current = serverId;
    void readDeploySuggestionCatalog({ serverId }).then((listed) => {
      if (listed.kind === 'catalog') setOwnCatalog(listed.catalog);
      // Without the snapshot the row keeps the default forge alone; reopening the step reads it again.
      else catalogRead.current = null;
    }).catch(() => {
      catalogRead.current = null;
    });
  }, [active, serverId, suggestion]);

  const catalog = suggestion?.catalog ?? ownCatalog;
  const forges = React.useMemo((): readonly NewAppForge[] => {
    if (!catalog) return NO_FORGES;
    if (!suggestion) return catalog.forges;
    const { recommendation } = suggestion;
    return catalog.forges.filter(
      (forge) =>
        validateDeploySuggestionV1(
          {
            recommendations: [
              { ...recommendation, repositoryProviderKind: forge.providerKind },
            ],
          },
          catalog,
        ).recommendations.length === 1,
    );
  }, [catalog, suggestion]);

  const [picked, setPicked] = React.useState<string | null>(null);
  const offered = (kind: string | null | undefined): kind is ScmHostingProviderKind =>
    Boolean(kind) && forges.some((forge) => forge.providerKind === kind);
  const suggested = suggestion?.recommendation.repositoryProviderKind;
  // Before the snapshot arrives, the default forge stands alone (GitHub is the default, decision 6).
  const chosen = !catalog
    ? DEFAULT_PROJECT_REPOSITORY_PROVIDER_KIND_V1
    : offered(picked)
      ? picked
      : offered(suggested)
        ? suggested
        : offered(DEFAULT_PROJECT_REPOSITORY_PROVIDER_KIND_V1)
          ? DEFAULT_PROJECT_REPOSITORY_PROVIDER_KIND_V1
          : (forges[0]?.providerKind ?? null);

  const [owners, setOwners] = React.useState<
    Readonly<Record<string, ForgeOwnerFact>>
  >({});
  const probes = React.useRef(new Map<string, number>());
  // Facts are per Machine checkout and forge: another Machine describes its own, and switching back reuses them.
  const scopeKey = `${machineId ?? ''}\u0000${homeDir ?? ''}`;
  const keyOf = (providerKind: string) => `${scopeKey}\u0000${providerKind}`;

  const describe = React.useCallback(
    (providerKind: ScmHostingProviderKind) => {
      const key = `${scopeKey}\u0000${providerKind}`;
      if (!machineId || !homeDir) {
        setOwners((current) => ({
          ...current,
          [key]: { kind: 'unavailable', providerName: null },
        }));
        return;
      }
      const probe = (probes.current.get(key) ?? 0) + 1;
      probes.current.set(key, probe);
      setOwners((current) =>
        current[key]?.kind === 'ready'
          ? current
          : { ...current, [key]: LOADING },
      );
      const settle = (fact: ForgeOwnerFact) => {
        if (probes.current.get(key) === probe)
          setOwners((current) => ({ ...current, [key]: fact }));
      };
      void machineScmHostingRepositoryDescribePublishTargets(machineId, {
        cwd: homeDir,
        providerKind,
      })
        .then((response) => {
          // The Git panel's publish owner decides what a describe answer needs; New app reads the same verdict.
          const targets =
            response && 'success' in response
              ? (response as ScmHostingRepositoryDescribePublishTargetsResponse)
              : null;
          const target =
            targets?.success === true
              ? (targets.targets.find((candidate) => candidate.isDefault) ??
                targets.targets[0] ??
                null)
              : null;
          const verdict = resolveSourceControlPublishRepositoryRemediation({
            targetsResponse: targets,
            selectedTarget: target,
            publishFailure: null,
          });
          const providerName = target?.provider.displayName ?? null;
          if (target && verdict.authState !== null && !verdict.authUnavailable)
            settle({ kind: 'ready', owner: target.owner, target });
          else if (
            verdict.action !== null ||
            (targets?.success === true && !verdict.authState)
          )
            settle({ kind: 'needsAccount', providerName });
          else settle({ kind: 'unavailable', providerName });
        })
        .catch(() => settle({ kind: 'unavailable', providerName: null }));
    },
    [homeDir, machineId, scopeKey],
  );

  // Once per offered forge (and the default before the snapshot) while the step is open; a probed forge is skipped.
  React.useEffect(() => {
    if (!active) return;
    const kinds = forges.length > 0 ? forges.map((forge) => forge.providerKind) : chosen ? [chosen] : [];
    for (const providerKind of kinds) {
      if (!probes.current.has(keyOf(providerKind)))
        describe(providerKind);
    }
  }, [active, chosen, describe, forges, scopeKey]);

  const markNeedsAccount = React.useCallback(() => {
    if (chosen)
      setOwners((current) => ({
        ...current,
        [`${scopeKey}\u0000${chosen}`]: { kind: 'needsAccount', providerName: null },
      }));
  }, [chosen, scopeKey]);
  const recheck = React.useCallback(() => {
    if (chosen) describe(chosen);
  }, [chosen, describe]);

  return {
    forges,
    chosen,
    owner: chosen
      ? (owners[keyOf(chosen)] ?? LOADING)
      : ({ kind: 'unavailable', providerName: null } as const),
    ownerOf: (providerKind: string): ForgeOwnerFact | undefined => owners[keyOf(providerKind)],
    choose: setPicked,
    recheck,
    markNeedsAccount,
  };
}
