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
  | Readonly<{ kind: 'needsAccount' | 'unavailable'; providerName: string | null; code?: string }>;

export type NewAppForge = Readonly<DeploySuggestionCatalogV1['forges'][number]>;

const LOADING: ForgeOwnerFact = Object.freeze({ kind: 'loading' });
const UNAVAILABLE: ForgeOwnerFact = Object.freeze({ kind: 'unavailable', providerName: null });
const NO_FORGES: readonly NewAppForge[] = Object.freeze([]);

/**
 * Code lives on (journey-deploy F5). The offered forges come from the catalog snapshot (`forges`): a suggested setup
 * keeps only forges its validator still admits with the suggested target; a starter picked by hand reads just the
 * publisher projection, since no target is chosen yet. Describe the chosen forge on entry, and the
 * remaining offered forges when the picker opens.
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
  const [ownCatalog, setOwnCatalog] = React.useState<Readonly<{
    serverId: string;
    catalog: DeploySuggestionCatalogV1 | null;
    code: string | null;
  }> | null>(null);
  const catalogRead = React.useRef<string | null>(null);
  const retryCatalog = React.useCallback(() => {
    if (!active || suggestion || !serverId || catalogRead.current === serverId) return;
    catalogRead.current = serverId;
    const settle = (catalog: DeploySuggestionCatalogV1 | null, code: string | null) => {
      if (catalogRead.current !== serverId) return;
      if (code) catalogRead.current = null;
      setOwnCatalog({ serverId, catalog, code });
    };
    void readDeploySuggestionCatalog({ serverId, input: { projection: 'forges' } }).then((listed) => {
      if (listed.kind === 'failed') settle(null, listed.code);
      else settle(listed.catalog, listed.catalog.issues?.find(issue => issue.section === 'forges')?.code ?? null);
    }, (error: unknown) => {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      settle(null, typeof code === 'string' ? code : 'action_failed');
    });
  }, [active, serverId, suggestion]);
  React.useEffect(retryCatalog, [retryCatalog]);

  const ownRead = ownCatalog?.serverId === serverId ? ownCatalog : null;
  const catalog = suggestion?.catalog ?? ownRead?.catalog;
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
  const keyOf = React.useCallback((providerKind: string) => `${scopeKey}\u0000${providerKind}`, [scopeKey]);

  const describe = React.useCallback(
    (providerKind: ScmHostingProviderKind) => {
      const key = keyOf(providerKind);
      if (!machineId || !homeDir) {
        setOwners((current) => ({
          ...current,
          [key]: UNAVAILABLE,
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
          const target =
            response.success
              ? (response.targets.find((candidate) => candidate.isDefault) ??
                response.targets[0] ??
                null)
              : null;
          const verdict = resolveSourceControlPublishRepositoryRemediation({
            targetsResponse: response,
            selectedTarget: target,
            publishFailure: null,
          });
          const providerName = target?.provider.displayName ?? null;
          if (target && verdict.authState !== null && !verdict.authUnavailable) {
            settle({ kind: 'ready', owner: target.owner, target });
            return;
          }
          const code = response.success ? undefined
            : typeof response.actionErrorCode === 'string' ? response.actionErrorCode : response.errorCode;
          const kind = verdict.action !== null || (response.success && !verdict.authState) ? 'needsAccount' : 'unavailable';
          settle({ kind, providerName, ...(code ? { code } : {}) });
        })
        .catch(() => settle(UNAVAILABLE));
    },
    [homeDir, keyOf, machineId],
  );

  const probeOnce = React.useCallback((providerKind: ScmHostingProviderKind) => {
    if (active && !probes.current.has(keyOf(providerKind))) describe(providerKind);
  }, [active, describe, keyOf]);
  React.useEffect(() => {
    if (chosen) probeOnce(chosen);
  }, [chosen, probeOnce]);
  const probeAll = React.useCallback(() => {
    for (const forge of forges) probeOnce(forge.providerKind);
  }, [forges, probeOnce]);

  const markNeedsAccount = React.useCallback(() => {
    if (chosen)
      setOwners((current) => ({
        ...current,
        [keyOf(chosen)]: { kind: 'needsAccount', providerName: null },
      }));
  }, [chosen, keyOf]);
  const recheck = React.useCallback(() => {
    if (chosen) describe(chosen);
  }, [chosen, describe]);

  return {
    forges,
    chosen,
    catalogFailure: suggestion ? null : ownRead?.code ?? null,
    retryCatalog,
    owner: chosen
      ? (owners[keyOf(chosen)] ?? LOADING)
      : UNAVAILABLE,
    ownerOf: (providerKind: string): ForgeOwnerFact | undefined => owners[keyOf(providerKind)],
    choose: setPicked,
    probeAll,
    recheck,
    markNeedsAccount,
  };
}
