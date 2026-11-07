import {
  MEMORY_ARCHIVE_TOPIC_TITLE_V1,
  isMemoryFactRenewableV1,
  type MemoryFactV1,
} from '@happier-dev/protocol/prompts/library/memoryDocV1';
import { HAPPIER_COLLECTION_RAIL_WIDTH_PX } from '@happier-dev/plugin-ui/advanced';
import {
  COLLECTION_RAIL_MIN_WIDTH_PX,
  HappierListDetailLayout,
  useHappierCollectionLayout,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ManagedSectionCount } from '@/components/settings/machines/managed/ManagedSectionCount';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import type { PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { NavigationBackChromeProvider } from '@/components/ui/layout/NavigationBackChrome';
import { NavigationTitleChromeProvider } from '@/components/ui/layout/navigationTitleChrome';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useCollectionRailWidth } from '@/components/ui/lists/collection/useCollectionRailWidth';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { buildDiscussionRouteHref } from '@/components/discussions/discussionRoutes';

import type { MemorySearchScope } from '@happier-dev/protocol/memory/memorySearch';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { showDocumentShareSheet } from '@/components/sharing/documents/showDocumentShareSheet';
import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';

import { MemoryDocumentBody, memoryTopicLabel } from './MemoryDocumentBody';
import { MemoryFactDetail } from './MemoryFactDetail';
import { memoryDocumentHref } from './memoryDocumentRoutes';
import { MemorySearchPanel } from './MemorySearchPanel';

/**
 * The Project this memory belongs to, when the page is that Project's Memory page (lab K2 `A`): the
 * header names it, search covers its memory and sessions, and facts open on its route.
 */
export type MemoryDocumentProjectPage = Readonly<{
  name: string;
  searchScope: MemorySearchScope;
  href: (options: Readonly<{ factId?: string; editFactId?: string }>) => string;
}>;
import { useMemoryDocument } from './useMemoryDocument';

/** The narrowest fact detail that keeps its labels beside their values. */
const FACT_DETAIL_MIN_WIDTH_PX = 420;

/**
 * A memory document's own pages (D48; lab K2 `A`/`Ap`): without `topic`, the index — every key fact,
 * decisions first, then the topic list; with `topic`, that one topic's facts (the archive is a topic).
 * A fact opens its detail (reason, source, approval, expiry, what agents see, history) beside the list
 * where both fit, and as its own pushed page on a phone. The selection is the route's `fact`.
 */
export const MemoryDocumentScreen = React.memo(function MemoryDocumentScreen(
  props: Readonly<{
    artifactId: string;
    serverId?: string;
    topic?: string;
    factId?: string;
    /** A fact page's Edit returns here with the fact's form open. */
    editFactId?: string;
    project?: MemoryDocumentProjectPage;
  }>,
) {
  const project = props.project;
  const scope = useActiveServerAccountScope();
  const serverId = props.serverId?.trim() || scope?.serverId || null;
  const ref = React.useMemo(
    () =>
      serverId
        ? { kind: 'doc' as const, artifactId: props.artifactId, serverId }
        : null,
    [props.artifactId, serverId],
  );
  const source = useMemoryDocument({
    ref,
    serverId,
    ...(props.topic ? { topic: props.topic } : {}),
  });
  const navigateToSession = useNavigateToSession();
  const router = useRouter();
  const { theme } = useUnistyles();
  const { fontScale } = useWindowDimensions();
  const railWidth = useCollectionRailWidth('memory');
  const openSession = React.useCallback(
    (target: Readonly<{ serverId: string; sessionId: string; messageId?: string }>) => {
      fireAndForget(
        navigateToSession(target.sessionId, { serverId: target.serverId, messageId: target.messageId }),
        { tag: 'MemoryDocumentScreen.source' },
      );
    },
    [navigateToSession],
  );
  const openDiscussion = React.useCallback((target: DiscussionMessageRefV1) => {
    const result = runGuardedNavigation(() => router.push(buildDiscussionRouteHref({
      target: { kind: 'discussion', address: target.discussion,
        discussionId: target.discussion.discussionId, messageId: target.messageId },
    }) as never));
    if (result !== true) fireAndForget(result, { tag: 'MemoryDocumentScreen.discussionSource' });
  }, [router]);
  const [composing, setComposing] = React.useState(false);
  const view = source.view;
  // Only the qualified document read admits access; ambient same-id rows cannot grant it.
  const documentAccess = view?.access ?? null;
  const readOnly = documentAccess === null || documentAccess === 'view';
  const archive = props.topic === MEMORY_ARCHIVE_TOPIC_TITLE_V1;
  const title = props.topic
    ? memoryTopicLabel(props.topic)
    : project ? t('projects.pages.memory')
    : (view?.title ?? t('memoryContext.memory.title'));
  const description = props.topic
    ? (view?.topic?.summary ?? '')
    : project ? t('memoryContext.memory.projectPageDescription', { project: project.name })
    : t('memoryContext.memory.pageDescription');
  // Who can see it and what this reader may do, from the admitted audience.
  const meta = React.useMemo((): PageHeaderMetaFact[] => {
    const facts: PageHeaderMetaFact[] = [];
    // The Project is known before its memory is read, so its line holds while the rest arrives.
    if (project)
      facts.push({
        key: 'scope',
        icon: 'folder',
        text: t('memoryContext.memory.projectScope', { project: project.name }),
        testID: 'memory-document.scope',
      });
    if (!view) return facts;
    if (view.shared === null) {
      facts.push({ key: 'audience', icon: 'question', text: t('memoryContext.memory.sharingUnknown'),
        testID: 'memory-document.audience' });
      facts.push({ key: 'retry-audience', text: t('common.retry'), onPress: () => {
        fireAndForget(source.refresh(), { tag: 'MemoryDocumentScreen.retryAudience' });
      }, testID: 'memory-document.retryAudience' });
    }
    // Project placement says nothing about which principals hold Artifact grants.
    if (view.shared === true)
      facts.push({
        key: 'audience',
        icon: 'users',
        text: view.audience?.team
          ? t('memoryContext.memory.sharedWithTeam', { team: view.audience.team })
          : t('memoryContext.memory.accessShared'),
        testID: 'memory-document.audience',
      });
    if (view.shared === false)
      facts.push({
        key: 'audience',
        icon: 'lock',
        text: t('memoryContext.memory.accessPrivate'),
        testID: 'memory-document.audience',
      });
    if (documentAccess !== null)
      facts.push({
        key: 'access',
        text:
          documentAccess === 'view'
            ? t('memoryContext.memory.youCanView')
            : t('memoryContext.memory.youCanEdit'),
        testID: 'memory-document.access',
      });
    return facts;
  }, [documentAccess, project, view, source.refresh]);
  const selectedFact = React.useMemo(
    () =>
      props.factId
        ? (view?.facts.find((fact) => fact.id === props.factId) ?? null)
        : null,
    [props.factId, view?.facts],
  );
  const hrefFor = React.useCallback(
    (options: Readonly<{ factId?: string; editFactId?: string }>) =>
      project && !props.topic
        ? project.href(options)
        : ref
          ? memoryDocumentHref(ref, {
              serverId,
              ...(props.topic ? { topic: props.topic } : {}),
              ...options,
            })
          : null,
    [project, props.topic, ref, serverId],
  );
  const openFact = React.useCallback(
    (fact: MemoryFactV1 | null, replace: boolean, editFactId?: string) => {
      const href = hrefFor({
        ...(fact ? { factId: fact.id } : {}),
        ...(editFactId ? { editFactId } : {}),
      });
      if (!href) return;
      const result = runGuardedNavigation(() =>
        replace ? router.replace(href as never) : router.push(href as never),
      );
      if (result !== true)
        fireAndForget(result, { tag: 'MemoryDocumentScreen.openFact' });
    },
    [hrefFor, router],
  );
  const scale = Math.max(1, fontScale);
  // Decisions lead the list, so the first one shown is the first decision.
  // Expired facts are folded away on the index, so the first one shown is the first live one.
  const nowMs = Date.now();
  const liveFacts = view?.facts.filter((fact) => fact.expiresAtMs === undefined || fact.expiresAtMs > nowMs) ?? [];
  const firstFact = liveFacts.find((fact) => fact.decision !== undefined) ?? liveFacts[0] ?? view?.facts[0] ?? null;

  const canRemember = Boolean(source.target) && !readOnly && !archive;
  const rememberButton = canRemember ? (
    <IconButton
      testID="memory-document.remember"
      iconName="plus"
      variant="plain"
      accessibilityLabel={t('memoryContext.memory.remember')}
      tooltip={t('memoryContext.memory.remember')}
      onPress={() => setComposing(true)}
    />
  ) : undefined;
  // Sharing is the document's own share sheet, offered to whoever may change who sees it.
  const canShare = !props.topic && (documentAccess === 'owner' || documentAccess === 'admin');
  const share = React.useCallback((event?: unknown) => {
    if (!view) return;
    showDocumentShareSheet({
      anchor: resolvePressTriggerAnchor(event),
      artifactId: props.artifactId,
      kind: null,
      name: view.title,
      ...(project ? { subtitle: t('memoryContext.memory.projectScope', { project: project.name }) } : {}),
    });
  }, [project, props.artifactId, view]);
  const headerActions = props.topic ? undefined : (canShare || rememberButton) ? (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 }}>
      {canShare ? (
        <RoundButton testID="memory-document.share" size="small" display="secondary" title={t('common.share')} onPress={share} />
      ) : null}
      {rememberButton}
    </View>
  ) : undefined;
  const Header = project ? PageHeader : SettingsPageHeader;

  const body = (split: boolean) => (
    <MemoryDocumentBody
      testID="memory-document"
      source={source}
      serverId={serverId ?? ''}
      preparationScope={project?.searchScope}
      readOnly={readOnly}
      composing={composing}
      onComposingChange={setComposing}
      emptyText={t('memoryContext.memory.empty')}
      renderEmpty={props.topic ? undefined : ({ testID }) => <SurfaceStateCard
        testID={testID} kind="empty" title={t('memoryContext.memory.decisionsFollow')}
        action={canRemember ? { testID: 'memory-document.add-decision', label: t('memoryContext.memory.addDecision'),
          onPress: () => setComposing(true) } : undefined}
      />}
      onOpenSession={openSession}
      // Beside the detail the selection moves in place; a phone pushes the fact's own page.
      onOpenFact={(fact) => openFact(fact, split)}
      selectedFactId={split ? (selectedFact?.id ?? null) : null}
      viewerAccountId={scope?.accountId ?? null}
      grouped={!props.topic}
      editFactId={props.editFactId}
    />
  );

  const list = (split: boolean) => (
    <ItemList>
      <Header
        title={title}
        description={description}
        meta={props.topic ? undefined : meta}
        actions={headerActions}
        actionsPlacement="page"
      />
      {props.topic ? (
        <ItemGroup
          title={t('memoryContext.memory.factsTitle')}
          titleAccessory={view ? <ManagedSectionCount count={view.facts.length} /> : undefined}
          actionLayout="trailing"
          // Facts sit in their own slots; the group still knows how many can be selected.
          selectableItemCountOverride={view?.facts.length ?? 0}
          action={rememberButton}
        >
          {body(split)}
        </ItemGroup>
      ) : project ? (
        // The Project's search heads its memory: typing searches its facts and sessions in place.
        <MemorySearchPanel
          testID="memory-document.search"
          serverId={serverId ?? ''}
          scope={project.searchScope}
          scopeName={project.name}
          autoFocus={false}
          placement="page"
          placeholder={t('memoryContext.memory.searchProjectPlaceholder', { project: project.name })}
          idle={body(split)}
        />
      ) : (
        body(split)
      )}
    </ItemList>
  );

  return (
    <View
      style={{
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
      }}
    >
      <HappierListDetailLayout
        testID="memory-document.layout"
        listTestID="memory-document.list-pane"
        detailTestID="memory-document.detail-pane"
        minListWidth={COLLECTION_RAIL_MIN_WIDTH_PX * scale}
        minDetailWidth={FACT_DETAIL_MIN_WIDTH_PX * scale}
        listWidthPx={railWidth.widthPx ?? HAPPIER_COLLECTION_RAIL_WIDTH_PX.detailed * scale}
        onListWidthCommit={railWidth.commit}
        onListWidthReset={railWidth.reset}
        preferredListRatio={0.5}
        labels={{
          resize: t('ui.resizableDockedPane.resizeA11y'),
          resizeHint: t('ui.resizableDockedPane.resizeHint'),
          resizeValue: (px) => t('ui.resizableDockedPane.resizeValue', { px }),
        }}
        listStyle={{
          borderRightWidth: 1,
          borderRightColor: theme.colors.border.default,
        }}
        list={(layout) => (
          <>
            <LandOnFirstFact
              split={layout?.mode === 'split'}
              selected={selectedFact !== null}
              first={firstFact}
              onLand={(fact) => openFact(fact, true)}
            />
            {list(layout?.mode === 'split')}
          </>
        )}
        detail={
          selectedFact ? (
            <FactDetailChrome key={selectedFact.id}>
              {(split) => (
                <MemoryFactDetail
                  testID="memory-document.factDetail"
                  fact={selectedFact}
                  documentRef={ref}
                  serverId={serverId}
                  viewerAccountId={
                    source.target?.accountId ?? scope?.accountId ?? null
                  }
                  archived={archive}
                  onOpenSession={openSession}
                  onOpenDiscussion={openDiscussion}
                  // Beside the list the form opens in place; a phone's fact page returns to the list to edit.
                  onEdit={canRemember || (archive && Boolean(source.target) && !readOnly
                    && isMemoryFactRenewableV1(selectedFact, nowMs))
                    ? () => openFact(split ? selectedFact : null, true, selectedFact.id) : undefined}
                />
              )}
            </FactDetailChrome>
          ) : null
        }
        detailActive={selectedFact !== null}
        // While the document is read the split holds, so the list never jumps when the first fact lands.
        idleDetail={!view && source.status === 'loading' ? (
          <ItemList>
            <SurfaceStateCard testID="memory-document.factDetail.loading" kind="loading" title={t('common.loading')} />
          </ItemList>
        ) : null}
        // Stacked, an edit requested from the fact (its form lives in the list) shows the list; a wide
        // window that narrows mid-edit otherwise keeps the auto-selected fact's page over the form.
        stackedPane={props.editFactId ? 'list' : 'detail'}
      />
    </View>
  );
});

/** A wide document always shows a fact: beside the list, the first one opens on arrival. */
function LandOnFirstFact(
  props: Readonly<{
    split: boolean;
    selected: boolean;
    first: MemoryFactV1 | null;
    onLand: (fact: MemoryFactV1) => void;
  }>,
): null {
  const { split, selected, first } = props;
  const land = React.useRef(props.onLand);
  land.current = props.onLand;
  const firstId = first?.id ?? null;
  const firstRef = React.useRef(first);
  firstRef.current = first;
  React.useEffect(() => {
    if (split && !selected && firstId && firstRef.current) land.current(firstRef.current);
  }, [firstId, selected, split]);
  return null;
}

/**
 * Beside the list the fact is a pane of this page: the page keeps its own title and back.
 */
function FactDetailChrome(props: Readonly<{ children: (split: boolean) => React.ReactNode }>) {
  const split = useHappierCollectionLayout()?.mode === 'split';
  const children = props.children(split);
  // A fact's words are its title and are read whole, so they stay in the page rather than being cut
  // into the navigation title; pushed on a phone, the page keeps its Back.
  if (!split) return <NavigationTitleChromeProvider showsTitle={false} showsBack>{children}</NavigationTitleChromeProvider>;
  return (
    <NavigationTitleChromeProvider showsTitle={false}>
      <NavigationBackChromeProvider control={null}>{children}</NavigationBackChromeProvider>
    </NavigationTitleChromeProvider>
  );
}
