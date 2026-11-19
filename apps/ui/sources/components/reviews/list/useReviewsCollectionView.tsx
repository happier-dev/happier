import * as React from 'react';
import type { CollectionConditionBindings } from '@happier-dev/plugin-ui/components';
import { createDefaultCollectionSpaceV1, type CollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import type {
  EntityDragScopeV1,
  EntityDropAdmissionV1,
  EntityDropEffectV1,
  EntityDropOutcomeV1,
} from '@happier-dev/protocol/plugins/ui';
import { entityDragScopesEqualV1 } from '@happier-dev/protocol/plugins/ui';
import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import {
  DEFAULT_REVIEW_LIST_FILTER_V1,
  ReviewListFilterV1Schema,
  reviewListFilterFieldsV1,
  type ReviewListFilterV1,
} from '@happier-dev/protocol/reviews/reviewListFilterV1';
import type {
  ReviewListItemV1,
  ReviewListRequestV1,
} from '@happier-dev/protocol/reviews/reviewListV1';
import type { ResourceSpaceMembershipMutationV1 } from '@happier-dev/protocol/collections/spaces/resourceSpaceMembershipV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { COLLECTION_SPACE_KIND_PRESENTATION } from '@/components/settings/session/collectionSpaceKindPresentation';
import { projectActionOutcome } from '@/components/sessions/shell/dropPreview/sessionListActionOutcome';
import {
  describeSessionListDropPreview,
  describeSessionListDropReason,
} from '@/components/sessions/shell/dropPreview/sessionListDropPresentation';
import {
  CollectionSpaceTabDropZone,
  type CollectionSpaceDrop,
} from '@/components/ui/lists/collection/CollectionSpaceTabDropZone';
import {
  createCollectionSpaceDraftStore,
  useCollectionSpaceFilter,
} from '@/components/ui/lists/collection/useCollectionSpaceFilter';
import { useCollectionSpaceHeader } from '@/components/ui/lists/collection/useCollectionSpaceHeader';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { EntityDropResolveContext } from '@/components/ui/treeDragDrop';
import {
  useActiveServerAccountScope,
  useActiveServerAccountScopeLifetime,
} from '@/sync/store/hooks';
import { t } from '@/text';

import { useReviewList } from '../useReviewList';

type ReviewSpace = CollectionSpaceV1<'review'>;
const MEMBERSHIP_ACTION = 'collection.space.membership.set';
const REVIEW_DRAG_KINDS = ['artifact'] as const;
const REVIEW_SPACE_ICON = createDefaultCollectionSpaceV1('review').icon;
const REVIEW_FILTER_FIELD_ICONS = Object.freeze({
  subjectKind: 'git-diff',
  state: 'circle-half',
  sourceKind: 'lightning',
  needsDecision: 'hourglass',
} as const);
/** One Reviews draft for every mounted Reviews list. */
const reviewsListDraft = createCollectionSpaceDraftStore<'review'>();

/** A space a Review can be added to or removed from: its definition keeps manual members. */
export function reviewSpaceTakesMembers(
  space: ReviewSpace | null | undefined,
): space is ReviewSpace & {
  membership: NonNullable<ReviewSpace['membership']>;
} {
  return Boolean(space?.membership);
}

/** The words a loaded row shows, so the local search narrows what the person can see (titles stay sealed). */
export function reviewRowWords(item: ReviewListItemV1): string {
  return [
    reviewSubjectLabel(item.subjectKind),
    reviewStateLabel(item.state),
  ].join(' ');
}

export function reviewSubjectLabel(
  kind: ReviewListItemV1['subjectKind'],
): string {
  return t(
    kind === 'pull_request'
      ? 'reviewWalkthrough.collection.subjectPullRequest'
      : kind === 'repository'
        ? 'reviewWalkthrough.collection.subjectRepository'
        : 'reviewWalkthrough.collection.subjectComparison',
  );
}

export function reviewStateLabel(state: ReviewListItemV1['state']): string {
  switch (state) {
    case 'running':
      return t('reviewWalkthrough.collection.stateRunning');
    case 'partial':
      return t('reviewWalkthrough.collection.statePartial');
    case 'failed':
      return t('reviewWalkthrough.collection.stateFailed');
    case 'cancelled':
      return t('reviewWalkthrough.collection.stateCancelled');
    case 'completed':
      return t('reviewWalkthrough.collection.stateCompleted');
  }
}

/**
 * The Reviews collection's saved views (plan 04 U3): the selected space and its conditions become the server's
 * Review query (filters are server-readable metadata; manual members are the Account's own associations). Search
 * narrows only the loaded rows, and says so.
 */
export function useReviewsCollectionView(focused: boolean) {
  const lifetime = useActiveServerAccountScopeLifetime();
  const binding = useCollectionSpaceFilter('review', {
    lifetime,
    defaultName: t(COLLECTION_SPACE_KIND_PRESENTATION.review.defaultNameKey),
    defaultFilter: DEFAULT_REVIEW_LIST_FILTER_V1,
    draft: reviewsListDraft,
  });
  const activeSpace = binding.activeSpace as ReviewSpace | null;
  const request = React.useMemo(
    (): ReviewListRequestV1 => ({
      ...(binding.filters as ReviewListFilterV1),
      limit: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1,
      ...(reviewSpaceTakesMembers(activeSpace)
        ? {
            spaceId: activeSpace.id,
            spaceMembershipMode: activeSpace.membership.mode,
          }
        : {}),
    }),
    [activeSpace, binding.filters],
  );
  // The default query stands until a saved space binds; a bound non-default space then asks once for its own rows.
  const list = useReviewList(request);
  // Search is this page's presentation over loaded rows, so it never waits on saved spaces to load.
  const [searchQuery, setSearchQuery] = React.useState('');
  useCurrentUiContextLocalCommands(focused ? [{
    key: 'reviews.query',
    title: t('common.search'),
    description: 'reviews.query — Search the loaded Review rows with {value: string}.',
    invoke: input => {
      if (!isJsonObject(input) || typeof input.value !== 'string') return false;
      setSearchQuery(input.value);
    },
  }, {
    key: 'reviews.view',
    title: t('sessionsList.filterButton'),
    description: 'reviews.view — Replace this Review collection view with a ReviewListFilterV1 object.',
    invoke: input => {
      const filters = ReviewListFilterV1Schema.safeParse(input);
      return filters.success && binding.setFilters(filters.data);
    },
  }] : []);
  const needle = searchQuery.trim().toLowerCase();
  const items = React.useMemo(() => {
    const loaded = list.items ?? null;
    if (!loaded || !needle) return loaded;
    return loaded.filter((item) =>
      reviewRowWords(item).toLowerCase().includes(needle),
    );
  }, [list.items, needle]);
  return {
    focused,
    list,
    items,
    searchQuery,
    setSearchQuery,
    filters: binding.filters,
    setFilters: binding.setFilters,
    spaces: binding.spaces as readonly ReviewSpace[],
    selectedSpaceId: binding.selectedSpaceId,
    selectedSpace: binding.selectedSpace as ReviewSpace | null,
    activeSpace,
    spacesEnabled: binding.spacesEnabled,
    spacesReady: binding.spacesReady,
    spaceSettingsScope: binding.spaceSettingsScope,
  };
}

export type ReviewsCollectionView = ReturnType<typeof useReviewsCollectionView>;

/** The canonical membership Action for one Review; the server decides the Account's association. */
export function useReviewSpaceMembership() {
  const scope = useActiveServerAccountScope();
  const { execute } = useMountedActionExecution(scope);
  return React.useCallback(
    (mutation: ResourceSpaceMembershipMutationV1) =>
      execute(MEMBERSHIP_ACTION, mutation),
    [execute],
  );
}

/**
 * Whether a carried item can join a Review space, and the membership Action that does it. Only a loaded Review of
 * this Account, onto a space that keeps manual members and is not the one being viewed.
 */
export function resolveReviewSpaceDrop(input: Readonly<{
  item: EntityDropResolveContext['item'];
  scope: EntityDragScopeV1 | null;
  loadedReviewIds: ReadonlySet<string>;
  spaces: readonly ReviewSpace[];
  activeSpaceId: string | null;
  spaceId: string;
}>): EntityDropAdmissionV1 {
  const refuse = (code: string): EntityDropAdmissionV1 => ({ status: 'refused', reason: describeSessionListDropReason(code) });
  if (!input.scope || !entityDragScopesEqualV1(input.item.scope, input.scope)) return refuse('scope-mismatch');
  if (input.item.kind !== 'artifact') return refuse('unsupported-item');
  const reviewId = input.item.artifactId;
  if (!input.loadedReviewIds.has(reviewId)) return refuse('source-missing');
  const target = input.spaces.find((space) => space.id === input.spaceId);
  if (!reviewSpaceTakesMembers(target)) return refuse('unavailable');
  // Dropping onto the space being viewed changes nothing: the row is already listed there.
  if (input.spaceId === input.activeSpaceId) return refuse('already-placed');
  const mutation: ResourceSpaceMembershipMutationV1 = { resourceKind: 'artifact', resourceId: reviewId, operation: 'add', spaceId: input.spaceId };
  return { status: 'allowed', effect: { actionId: MEMBERSHIP_ACTION, input: mutation,
    preview: describeSessionListDropPreview({ kind: 'space-membership', spaceName: target.name, operation: 'add' }) } };
}

/** Add to space by dragging a loaded Review onto a space tab: admission from the list, effect through the Action. */
function useReviewSpaceDrop(view: ReviewsCollectionView): () => CollectionSpaceDrop | null {
  const scope = useActiveServerAccountScope();
  const { execute } = useMountedActionExecution(scope);
  const latest = React.useRef({ view, scope, execute });
  latest.current = { view, scope, execute };
  const drop = React.useMemo((): CollectionSpaceDrop => ({
    resolve: (context: EntityDropResolveContext, spaceId: string): EntityDropAdmissionV1 => {
      const { view: current, scope: currentScope } = latest.current;
      return resolveReviewSpaceDrop({ item: context.item, scope: currentScope ?? null,
        loadedReviewIds: new Set(current.list.items?.map((item) => item.reviewId) ?? []),
        spaces: current.spaces, activeSpaceId: current.activeSpace?.id ?? null, spaceId });
    },
    execute: async (effect: EntityDropEffectV1): Promise<EntityDropOutcomeV1> =>
      projectActionOutcome(effect.actionId, await latest.current.execute(MEMBERSHIP_ACTION, effect.input)),
  }), []);
  return React.useCallback(() => drop, [drop]);
}

/**
 * The Reviews saved-view header (plan 04 U3, lab list-strip/list-search/list-drag): the shared title chevron (view
 * menu), spaces strip with + New space, condition tokens, filter button and editor of Sessions and Workflows, bound to
 * the Reviews view. Each space tab takes a dragged Review through the shared tab drop target.
 */
export function useReviewsSpaceHeader(
  view: ReviewsCollectionView,
  testIDPrefix: string,
) {
  const focusEligible = usePluginSurfaceFocusEligibility();
  const spaceDrop = useReviewSpaceDrop(view);
  const bindings = React.useMemo(
    (): CollectionConditionBindings => ({
      fields: {
        subjectKind: {
          label: t('reviewWalkthrough.collection.fieldSubject'),
          valueOptions: (
            ['comparison', 'pull_request', 'repository'] as const
          ).map((value) => ({ value, label: reviewSubjectLabel(value) })),
        },
        state: {
          label: t('reviewWalkthrough.collection.fieldState'),
          valueOptions: (
            ['running', 'completed', 'partial', 'failed', 'cancelled'] as const
          ).map((value) => ({ value, label: reviewStateLabel(value) })),
        },
        sourceKind: {
          label: t('reviewWalkthrough.collection.fieldSource'),
          valueOptions: [
            {
              value: 'direct',
              label: t('reviewWalkthrough.collection.sourceDirect'),
            },
            {
              value: 'workflow',
              label: t('reviewWalkthrough.collection.sourceWorkflow'),
            },
          ],
        },
        needsDecision: {
          label: t('reviewWalkthrough.collection.fieldPending'),
        },
      },
    }),
    [],
  );
  // What people narrow Reviews by most, one press in the title menu: the ones waiting on their decision.
  const facets = React.useMemo(
    () => [
      {
        fieldId: 'needsDecision',
        value: true,
        label: t('reviewWalkthrough.collection.pendingFacet'),
      },
    ],
    [],
  );
  const wrapTabTarget = React.useCallback(
    (spaceId: string, tab: React.ReactElement) => (
      <CollectionSpaceTabDropZone
        spaceId={spaceId}
        acceptedKinds={REVIEW_DRAG_KINDS}
        spaceDrop={spaceDrop}
        testID={`${testIDPrefix}-drop:${spaceId}`}
      >
        {tab}
      </CollectionSpaceTabDropZone>
    ),
    [spaceDrop, testIDPrefix],
  );
  return useCollectionSpaceHeader({
    entityKind: 'review',
    keyboardEnabled: focusEligible && view.focused,
    testIDPrefix,
    defaultName: t(COLLECTION_SPACE_KIND_PRESENTATION.review.defaultNameKey),
    view,
    registry: reviewListFilterFieldsV1,
    bindings,
    fieldIcons: REVIEW_FILTER_FIELD_ICONS,
    facets,
    // A loaded page is partial while the server supplies a continuation cursor.
    result: {
      matchedCount: view.list.items?.length ?? 0,
      coverage: view.list.items ? (view.list.cursor ? 'partial' : 'complete') : 'unavailable',
    },
    defaultIcon: REVIEW_SPACE_ICON,
    titleScale: 'section',
    wrapTabTarget,
  });
}
