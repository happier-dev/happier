import { resolveSkillReachV1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import { useSkillFeatureEnabled } from './useSkillFeatureEnabled';
import * as React from 'react';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import {
  isReadOnlySkillProvenanceV1,
  type SkillListItemV1,
  type SkillUnavailableItemV1,
} from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { getStorage } from '@/sync/domains/state/storage';
import { skillUsageObservedSinceV1 } from '@happier-dev/protocol/prompts/library/skills/skillUsageV1';
import { isMigratedReachRuleIdV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import { resolveArtifactOrganizationHeaderV1 } from '@happier-dev/protocol/artifacts/artifactOrganizationV1';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { usePromptLibraryCatalogSelection } from '@/sync/store/usePromptLibraryCatalog';
import type { PromptLibraryCatalogValueSnapshot } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { refreshPromptLibraryCatalog } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
  areServerAccountScopesEqual,
  type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { useAppShellPluginUiDeclarationSources } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { createPluginSkillSourceIdentityPublication, EMPTY_PLUGIN_SKILL_SOURCE_IDENTITY, type PluginSkillSourceIdentity } from './pluginSkillSourceIdentity';

export type SkillsLibraryStatus = 'loading' | 'ready' | 'unavailable';
export type SkillsLibrary = Readonly<{
  scope: Readonly<{ serverId: string; accountId: string }> | null;
  /** `unavailable`: the read failed; never rendered as an empty library (D28). */
  status: SkillsLibraryStatus;
  /** Last-known items, kept through a refresh and through a failed refresh. */
  items: readonly SkillListItemV1[];
  /** Known identities with unreadable content; no description, trust or cost is fabricated. */
  unavailableItems?: readonly SkillUnavailableItemV1[];
  /** Items are from an earlier read while a newer one is pending or failed. */
  stale: boolean;
  errorCode: string | null;
  /** Oldest retained use, or unknown when the usage row is empty/unreadable. */
  usageObservedSince: number | null;
  retry: () => void;
}>;

type Snapshot = Readonly<{
  items: readonly SkillListItemV1[];
  unavailableItems: readonly SkillUnavailableItemV1[];
  key: string;
  pluginRevision: PluginSkillSourceIdentity;
  usageObservedSince: number | null;
}>;
/** Last-known `skills.list` result per Account, so reopening the page never flashes empty. */
const lastKnown = new Map<string, Snapshot>();
// Cold observers join one active read and validate its revisions against later
// inventory publication. No response or extra cache survives settlement here.
const readsInFlight = new Map<string, Readonly<{ pending: Promise<ActionExecuteResult>; sourceKey: string | null;
  sourceRevisions: readonly string[] | null;
  pluginRevision: PluginSkillSourceIdentity | null; pluginSourcesCurrent: () => boolean }>>();
function readSkills(scope: NonNullable<SkillsLibrary['scope']>, sourceRevisions: readonly string[] | null = null,
  pluginRevision: PluginSkillSourceIdentity | null = null) {
  const key = `${scope.serverId}:${scope.accountId}`;
  const existing = readsInFlight.get(key);
  if (existing) return existing;
  const pluginIdentity = createPluginSkillSourceIdentityPublication();
  const pluginSources = () => pluginIdentity.publish(readCurrentAppShellPluginUiProjection({ scope, declarationsOnly: true }));
  const initialPluginSources = pluginSources();
  // The front door captures the exact Account lifetime, independent of either mounted observer.
  const execute = createFrontDoorActionExecute();
  const pending = Promise.resolve()
    .then(() =>
      execute(
        'skills.list',
        {},
        {
          surface: 'ui',
          authority: 'present_user',
          actionCaller: { kind: 'host' },
          serverId: scope.serverId,
          expectedAccountId: scope.accountId,
        },
      ),
    )
    .finally(() => {
      if (readsInFlight.get(key)?.pending === pending) readsInFlight.delete(key);
    });
  const read = { pending, sourceKey: sourceRevisions === null ? null : contentKey(sourceRevisions), sourceRevisions,
    pluginRevision, pluginSourcesCurrent: () => pluginSources() === initialPluginSources };
  readsInFlight.set(key, read);
  return read;
}
/** The Account's last-known library, for a surface that paints before it reads (the composer `$`). */
export function peekSkillsLibraryItems(
  scope: NonNullable<SkillsLibrary['scope']>,
): readonly SkillListItemV1[] | null {
  return lastKnown.get(`${scope.serverId}:${scope.accountId}`)?.items ?? null;
}
/**
 * One current `skills.list` read for a surface that does not mount the library (the composer `$`, read
 * only once its picker opens), joined with an identical read already in flight. A failed read keeps
 * the last-known items; it never reports an empty library.
 */
export async function readSkillsLibraryItems(
  scope: NonNullable<SkillsLibrary['scope']>,
): Promise<readonly SkillListItemV1[] | null> {
  const scopeKey = `${scope.serverId}:${scope.accountId}`;
  try {
    const result = await readSkills(scope).pending;
    if (result.ok) {
      const parsed = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(
        result.result,
      );
      // The next `$` paints from this read at once; a mounted library still re-reads (its key never matches '').
      lastKnown.set(scopeKey, {
        items: parsed.items,
        unavailableItems: parsed.unavailableItems ?? [],
        key: '',
        pluginRevision: EMPTY_PLUGIN_SKILL_SOURCE_IDENTITY,
        usageObservedSince: parsed.usageObservedSince ?? null,
      });
      return parsed.items;
    }
  } catch {
    /* the last-known library answers below */
  }
  return peekSkillsLibraryItems(scope);
}
const emptyItems: readonly SkillListItemV1[] = Object.freeze([]);
const emptyUnavailableItems: readonly SkillUnavailableItemV1[] = Object.freeze(
  [],
);
const readRules = (snapshot: PromptLibraryCatalogValueSnapshot<'skill-rules'>) => snapshot.value;
const readRulesError = (snapshot: PromptLibraryCatalogValueSnapshot<'skill-rules'>) =>
  snapshot.status === 'unavailable' ? snapshot.reason ?? 'library_unavailable' : null;
const readUsage = (snapshot: PromptLibraryCatalogValueSnapshot<'skill-usage'>) => snapshot.status === 'ready' ? snapshot.value : null;
const readFolders = (snapshot: PromptLibraryCatalogValueSnapshot<'folders'>) => snapshot.value;

function contentKey(skills: readonly string[]): string {
  return JSON.stringify([...skills].sort());
}

/** Reuse the previous row object for an unchanged item, so memoised rows keep their identity. */
function reconcile<T extends Readonly<{ skillId: string }>>(
  previous: readonly T[],
  next: readonly T[],
): readonly T[] {
  const byId = new Map(previous.map((item) => [item.skillId, item]));
  let changed = previous.length !== next.length;
  const merged = next.map((item, index) => {
    const prior = byId.get(item.skillId);
    const kept =
      prior && JSON.stringify(prior) === JSON.stringify(item) ? prior : item;
    if (kept !== previous[index]) changed = true;
    return kept;
  });
  return changed ? merged : previous;
}

/**
 * The Skills library as `skills.list` returns it, through the mounted Action executor (one owner for
 * the list, the same projection agents and the CLI read). It re-reads changed skill content;
 * rules and usage project their existing scoped rows without reopening bodies.
 * Keeps the last-known list while reading and reports failures as `unavailable`, never empty.
 */
export function useSkillsLibrary(
  requestedScope?: ServerAccountScope | null,
): SkillsLibrary {
  const activeScope = useAccountSettingsScope();
  const scope = requestedScope === undefined ? activeScope : requestedScope;
  const isFeatureEnabled = useSkillFeatureEnabled(scope?.serverId);
  const scopeKey = scope ? `${scope.serverId}:${scope.accountId}` : null;
  const { binding, ready } = useMountedActionExecution(scope);
  const skillRevisions = getStorage()(state => state.artifactSkillRevisions);
  const inventoryReady = getStorage()(state => state.isDataReady && state.artifactsLoaded && state.artifactInventoryUnreadyCount === 0);
  const inventoryComplete = inventoryReady && areServerAccountScopesEqual(scope, activeScope);
  const rules = usePromptLibraryCatalogSelection('skill-rules', readRules, scope);
  const rulesError = usePromptLibraryCatalogSelection('skill-rules', readRulesError, scope);
  const usage = usePromptLibraryCatalogSelection('skill-usage', readUsage, scope);
  const folders = usePromptLibraryCatalogSelection('folders', readFolders, scope);
  const declarations = useAppShellPluginUiDeclarationSources();
  const readsActiveScope = areServerAccountScopesEqual(scope, activeScope);
  const pluginRevision = readsActiveScope ? declarations.skillSourceIdentity : EMPTY_PLUGIN_SKILL_SOURCE_IDENTITY;
  const pluginSourcesReady = !readsActiveScope || declarations.ready;
  // Reach and usage already have scoped publications below. Content reads depend on
  // membership and revisions; unknown membership is distinct from an empty inventory.
  const sourceRevisions = React.useMemo(() => readsActiveScope ? Object.values(skillRevisions) : [], [readsActiveScope, skillRevisions]);
  const sourceKey = React.useMemo(() => contentKey(sourceRevisions), [sourceRevisions]);
  const completedRead = React.useRef<Readonly<{ observationKey: string; sourceRevisions: readonly string[];
    pluginRevision: PluginSkillSourceIdentity }> | null>(null);
  const [state, setState] = React.useState<{
    scopeKey: string | null;
    snapshot: Snapshot | null;
    status: SkillsLibraryStatus;
    errorCode: string | null;
  }>(() => ({
    scopeKey,
    snapshot: scopeKey ? (lastKnown.get(scopeKey) ?? null) : null,
    status: 'loading',
    errorCode: null,
  }));
  const [attempt, setAttempt] = React.useState(0);
  const retry = React.useCallback(() => {
    if (scope)
      fireAndForget(refreshPromptLibraryCatalog(scope), {
        tag: 'skillsLibrary.retry',
      });
    setAttempt((value) => value + 1);
  }, [scope]);
  // skills.list refreshes unavailable rules through this same catalog owner.
  // Starting it on failure would reopen loading and cancel its own invocation.
  const canRead = Boolean(scopeKey) && ready && pluginSourcesReady && rulesError === null;
  const readKey = JSON.stringify([
    scopeKey,
    binding?.revision,
    sourceKey,
    attempt,
  ]);
  const observationKey = JSON.stringify([scopeKey, binding?.revision, attempt]);

  React.useEffect(() => {
    if (!scopeKey || !scope || !canRead) return;
    // The Action has already read complete membership. Partial sync may publish
    // those same headers later; only a new/changed or removed known row invalidates
    // that result. A complete inventory also proves exact membership.
    const completed = completedRead.current;
    if (completed?.observationKey === observationKey && completed.pluginRevision === pluginRevision && state.status === 'ready' && state.snapshot) {
      const published = new Set(sourceRevisions);
      const known = new Set(state.snapshot.items.filter(item => !isReadOnlySkillProvenanceV1(item.provenance))
        .map(item => `${item.skillId}@${item.revision}`));
      const unchanged = inventoryComplete ? state.snapshot.key === sourceKey && state.snapshot.pluginRevision === pluginRevision
        : state.snapshot.unavailableItems.length === 0 && sourceRevisions.every(revision => known.has(revision))
          && completed.sourceRevisions.every(revision => published.has(revision));
      if (unchanged) {
        completedRead.current = { observationKey, sourceRevisions, pluginRevision };
        return;
      }
    }
    const controller = new AbortController();
    setState((prev) =>
      prev.scopeKey === scopeKey && prev.status === 'loading'
        ? prev
        : { ...prev, scopeKey, status: 'loading' },
    );
    void (async () => {
      try {
        const read = readSkills(scope, sourceRevisions, pluginRevision);
        const result = await read.pending;
        if (controller.signal.aborted) return;
        if (!result.ok) {
          setState((prev) => ({
            ...prev,
            scopeKey,
            status: 'unavailable',
            errorCode: result.errorCode ?? 'library_unavailable',
          }));
          return;
        }
        const parsed = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(
          result.result,
        );
        const resultKey = parsed.unavailableItems?.length ? null : contentKey(parsed.items
          .filter(item => !isReadOnlySkillProvenanceV1(item.provenance))
          .map(item => `${item.skillId}@${item.revision}`));
        // A changed membership/revision during the cold read needs a fresh
        // observation. Never relabel an older response as the newer mutation.
        const knownRevisions = new Set(parsed.items.filter(item => !isReadOnlySkillProvenanceV1(item.provenance))
          .map(item => `${item.skillId}@${item.revision}`));
        // A picker has no observed inventory/declaration revision. Its complete
        // response may satisfy a mounted observer, but never a newer publication.
        const published = new Set(sourceRevisions);
        const sourceChanged = read.sourceKey !== sourceKey && (inventoryComplete ? resultKey !== sourceKey
          : sourceRevisions.some(revision => !knownRevisions.has(revision))
            || (read.sourceRevisions ?? []).some(revision => !published.has(revision)));
        if (!read.pluginSourcesCurrent() || read.pluginRevision !== null && read.pluginRevision !== pluginRevision || sourceChanged) {
          setAttempt(value => value + 1);
          return;
        }
        completedRead.current = { observationKey, sourceRevisions, pluginRevision };
        setState((prev) => {
          const previous =
            prev.scopeKey === scopeKey
              ? (prev.snapshot?.items ?? emptyItems)
              : emptyItems;
          const snapshot: Snapshot = {
            items: reconcile(previous, parsed.items),
            unavailableItems: reconcile(
              prev.scopeKey === scopeKey
                ? (prev.snapshot?.unavailableItems ?? emptyUnavailableItems)
                : emptyUnavailableItems,
              parsed.unavailableItems ?? emptyUnavailableItems,
            ),
            key: resultKey ?? sourceKey,
            pluginRevision,
            usageObservedSince: parsed.usageObservedSince ?? null,
          };
          lastKnown.set(scopeKey, snapshot);
          return { scopeKey, snapshot, status: 'ready', errorCode: null };
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        const code =
          error &&
          typeof error === 'object' &&
          'code' in error &&
          typeof error.code === 'string'
            ? error.code
            : 'library_unavailable';
        setState((prev) => ({
          ...prev,
          scopeKey,
          status: 'unavailable',
          errorCode: code,
        }));
      }
    })();
    return () => controller.abort();
  }, [scopeKey, canRead, sourceKey, readKey, observationKey, inventoryComplete, pluginRevision]);

  const snapshot =
    state.scopeKey === scopeKey
      ? state.snapshot
      : scopeKey
        ? (lastKnown.get(scopeKey) ?? null)
        : null;
  const displayedItems = React.useMemo(() => {
    if (!snapshot) return emptyItems;
    return reconcile(
      snapshot.items,
      snapshot.items.map((item) => {
        const current = rules?.rules.filter(
          (rule) => rule.skillId === item.skillId,
        ) ?? item.rules;
        const { lastUsedAt: previousUse, ...withoutUse } = item;
        const lastUsedAt = usage && Object.hasOwn(usage.lastUsedAt, item.skillId)
          ? usage.lastUsedAt[item.skillId] : undefined;
        const migratedFromContext = current.some(rule => isMigratedReachRuleIdV1(rule.id));
        // The Action already resolved the safe owned-legacy fallback. Live personal
        // placement (including explicit null) overrides it through the same owner.
        const personalFolderId = resolveArtifactOrganizationHeaderV1({ artifactId: item.skillId,
          artifactHeadersById: folders?.artifactHeadersById, header: {}, owned: false }).folderId;
        const folderId = isReadOnlySkillProvenanceV1(item.provenance) ? null
          : personalFolderId === undefined ? item.folderId : personalFolderId;
        return JSON.stringify(item.rules) === JSON.stringify(current) && previousUse === lastUsedAt
          && item.migratedFromContext === migratedFromContext && item.folderId === folderId ? item
          : { ...withoutUse, rules: current, migratedFromContext, folderId, ...(lastUsedAt === undefined ? {} : { lastUsedAt }) };
      }),
    );
  }, [snapshot, rules, usage, folders]);
  const availableItems = React.useMemo(() => displayedItems.filter(item => resolveSkillReachV1(item.skillId, [], {
    machineId: '', machinePlatform: null, directory: null, projectKey: null, agentId: null }, isFeatureEnabled).available),
  [displayedItems, isFeatureEnabled]);
  const status: SkillsLibraryStatus =
    rulesError !== null
      ? 'unavailable'
      : !pluginSourcesReady ? 'loading'
      : state.scopeKey === scopeKey
        ? state.status
        : 'loading';
  const errorCode =
    rulesError !== null
      ? rulesError
      : state.errorCode;
  return React.useMemo(
    () => ({
      scope,
      status: status === 'loading' && snapshot ? 'ready' : status,
      items: availableItems,
      unavailableItems: snapshot?.unavailableItems ?? emptyUnavailableItems,
      stale:
        snapshot !== null && (status !== 'ready' || inventoryComplete
          && (snapshot.key !== sourceKey || snapshot.pluginRevision !== pluginRevision)),
      errorCode: status === 'unavailable' ? errorCode : null,
      usageObservedSince: skillUsageObservedSinceV1(usage),
      retry,
    }),
    [
      scope,
      status,
      snapshot,
      availableItems,
      sourceKey,
      pluginRevision,
      inventoryComplete,
      errorCode,
      retry,
      usage,
    ],
  );
}
