import * as React from 'react';
import { View } from 'react-native';
import { Redirect, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';
import { useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';
import {
    resolveSettingsNestedRouteName,
    type SettingsNestedNavigator,
} from '@/components/settings/navigation/settingsRouteRegistry';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useArtifacts, useArtifactsLoaded } from '@/sync/domains/state/storage';
import { PROMPT_LIBRARY_ARTIFACT_KINDS } from '@/sync/domains/artifacts/artifactInventory';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { invalidatePromptLibraryCatalogProjection } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    buildPromptLibraryCollection,
    buildPromptTemplateCollection,
    promptCollectionDraftHref,
    promptCollectionItemHref,
    promptCollectionRoot,
    readLastVisitedPromptCollectionId,
    recordPromptCollectionVisit,
    resolvePromptCollectionLandingId,
    resolvePromptCollectionRoute,
    type PromptCollection,
    type PromptCollectionKind,
    type PromptCollectionRow,
} from './promptCollectionModel';
import { CollectionDraftRow, CollectionList, CollectionListGroupLabel, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import {
    useHappierCollectionIndexView,
    useHappierCollectionLayout,
} from '@happier-dev/plugin-ui/presentation';

/** The collection offers a search field only once it no longer fits at a glance. */
const SEARCH_THRESHOLD = 8;
/** The narrowest editor that still fits a field beside its label. */
const PROMPT_DETAIL_MIN_WIDTH_PX = 480;

const NAVIGATORS: Readonly<Record<Exclude<PromptCollectionKind, 'bundle'>, SettingsNestedNavigator>> = {
    doc: 'prompts/docs',
    template: 'prompts/templates',
};

function collectionCopy(kind: PromptCollectionKind) {
    switch (kind) {
        case 'doc': return {
            title: t('promptLibrary.prompts'),
            description: t('promptLibrary.surface.docsDescription'),
            add: t('promptLibrary.surface.addPrompt'),
            draft: t('promptLibrary.newPrompt'),
            search: t('promptLibrary.surface.searchPrompts'),
            emptyTitle: t('promptLibrary.noPrompts'),
            emptySubtitle: t('promptLibrary.noPromptsSubtitle'),
            untitled: t('promptLibrary.untitledPrompt'),
            testID: 'promptLibrary.collection.doc',
        } as const;
        case 'bundle': return {
            title: t('promptLibrary.skills'),
            description: t('promptLibrary.surface.skillsDescription'),
            add: t('promptLibrary.surface.addSkill'),
            draft: t('promptLibrary.newSkill'),
            search: t('promptLibrary.surface.searchSkills'),
            emptyTitle: t('promptLibrary.noSkills'),
            emptySubtitle: t('promptLibrary.noSkillsSubtitle'),
            untitled: t('promptLibrary.untitledSkill'),
            testID: 'promptLibrary.collection.bundle',
        } as const;
        case 'template': return {
            title: t('promptLibrary.templates'),
            description: t('promptLibrary.surface.templatesDescription'),
            add: t('promptLibrary.surface.addTemplate'),
            draft: t('promptLibrary.newTemplate'),
            search: t('promptLibrary.surface.searchTemplates'),
            emptyTitle: t('promptLibrary.templatesEmptyTitle'),
            emptySubtitle: t('promptLibrary.templatesEmptySubtitle'),
            untitled: t('promptLibrary.newTemplate'),
            testID: 'promptLibrary.collection.template',
        } as const;
    }
}

/** The items of one prompt collection, filtered by `query`, grouped by folder where that says something. */
export function usePromptCollection(kind: PromptCollectionKind, query: string): PromptCollection & Readonly<{
    status: 'loading' | 'ready' | 'unavailable';
    stale: boolean;
    retry?: () => Promise<void>;
}> {
    const artifacts = useArtifacts('promptLibrary');
    const artifactsLoaded = useArtifactsLoaded(PROMPT_LIBRARY_ARTIFACT_KINDS);
    const scope = useAccountSettingsScope();
    const { value: folders } = usePromptLibraryCatalogValue('folders');
    const invocations = usePromptLibraryCatalogValue('invocations');
    const untitled = kind === 'doc' ? t('promptLibrary.untitledPrompt') : t('promptLibrary.untitledSkill');
    const collection = React.useMemo(() => (kind === 'template'
        ? buildPromptTemplateCollection({ invocations: invocations.value, query })
        : buildPromptLibraryCollection({ kind, artifacts, folders, query, untitledTitle: untitled })),
    [artifacts, folders, invocations.value, kind, query, untitled]);
    const retry = React.useCallback(async () => {
        if (scope) await invalidatePromptLibraryCatalogProjection(scope);
    }, [scope]);
    const status = kind === 'template' ? invocations.status : artifactsLoaded ? 'ready' : 'loading';
    const stale = kind === 'template' ? invocations.stale : !artifactsLoaded;
    return React.useMemo(() => ({ ...collection, status, stale, retry: kind === 'template' && scope ? retry : undefined }),
        [collection, status, stale, kind, scope, retry]);
}

/** Readiness comes from the catalog/artifact owner, never from an empty projected array. */
const PromptCollectionReadState = React.memo(function PromptCollectionReadState(props: Readonly<{
    kind: PromptCollectionKind;
    collection: ReturnType<typeof usePromptCollection>;
}>) {
    const { collection } = props;
    if (collection.status === 'ready' && !collection.stale) return null;
    const copy = collectionCopy(props.kind);
    const loading = collection.status === 'loading';
    const title = t(loading ? 'common.loading' : 'common.error');
    const action = !loading && collection.retry ? { label: t('common.retry'), onPress: collection.retry } : undefined;
    return collection.total > 0 ? (
        <SurfaceFreshnessLine testID={`${copy.testID}.freshness`} reason={title} busy={loading} action={action} />
    ) : (
        <SurfaceStateCard testID={`${copy.testID}.readState`} kind={loading ? 'loading' : 'unavailable'} title={title} action={action} />
    );
});

function openHref(router: ReturnType<typeof useRouter>, href: string, replace: boolean, tag: string) {
    const result = runGuardedNavigation(() => (replace ? router.replace(href as never) : router.push(href as never)));
    if (result !== true) fireAndForget(result, { tag });
}

/** The collection's "+": a new item as a selected draft at the top of the list, its editor beside it. */
export const PromptCollectionAddButton = React.memo(function PromptCollectionAddButton(props: Readonly<{
    kind: PromptCollectionKind;
}>) {
    const router = useRouter();
    const pathname = usePathname();
    const copy = collectionCopy(props.kind);
    const route = resolvePromptCollectionRoute(props.kind, pathname);
    const besideDetail = useHappierCollectionLayout()?.mode === 'split' && route !== null && route.kind !== 'index';
    return (
        <IconButton
            testID={`${copy.testID}.add`}
            iconName="plus"
            accessibilityLabel={copy.add}
            tooltip={copy.add}
            variant="plain"
            onPress={() => openHref(router, promptCollectionDraftHref(props.kind), besideDetail, 'PromptCollection.add')}
        />
    );
});

const PromptCollectionDraftRow = React.memo(function PromptCollectionDraftRow(props: Readonly<{ kind: PromptCollectionKind }>) {
    const titles = useCollectionDraftTitle();
    const copy = collectionCopy(props.kind);
    return (
        <CollectionDraftRow
            rowRole="item"
            testID={`${copy.testID}.draft`}
            titles={titles}
            placeholder={copy.draft}
            mark={null}
        />
    );
});

/** The rail beside a prompt, skill or template, grouped by folder when any item has one. */
export const PromptCollectionRail = React.memo(function PromptCollectionRail(props: Readonly<{ kind: PromptCollectionKind }>) {
    const router = useRouter();
    const pathname = usePathname();
    const copy = collectionCopy(props.kind);
    const [query, setQuery] = React.useState('');
    const collection = usePromptCollection(props.kind, query);
    const route = resolvePromptCollectionRoute(props.kind, pathname);
    const selectedId = route?.kind === 'item' ? route.id : null;
    React.useEffect(() => {
        if (selectedId) recordPromptCollectionVisit(props.kind, selectedId);
    }, [props.kind, selectedId]);
    const rows = collection.groups.flatMap((group) => group.rows);
    const renderRow = (row: PromptCollectionRow) => (
        <Item
            rowRole={props.kind === 'template' ? 'catalogRow' : 'item'}
            key={row.id}
            testID={`${copy.testID}.row.${row.id}`}
            title={row.title}
            subtitle={row.subtitle}
            selected={row.id === selectedId}
            density="compact"
            showChevron={false}
            pressableStyle={collectionListStyles.row}
            onPress={() => openHref(router, promptCollectionItemHref(props.kind, row.id), route?.kind !== 'index', 'PromptCollectionRail.open')}
        />
    );
    return (
        <CollectionList
            testID={`${copy.testID}.rail`}
            title={copy.title}
            count={collection.status === 'ready' && !collection.stale ? collection.total : undefined}
            headerAction={<PromptCollectionAddButton kind={props.kind} />}
            search={collection.total > SEARCH_THRESHOLD ? {
                testID: `${copy.testID}.search`,
                value: query,
                onChangeText: setQuery,
                placeholder: copy.search,
            } : null}
        >
            <PromptCollectionReadState kind={props.kind} collection={collection} />
            {route?.kind === 'draft' ? <PromptCollectionDraftRow kind={props.kind} /> : null}
            {/* Known to be empty (never while it is still being read): one line, like the MCP and Skills rails. */}
            {collection.status === 'ready' && !collection.stale && collection.total === 0 && route?.kind !== 'draft' ? (
                <EmptyState testID={`${copy.testID}.railEmpty`} layout="line" title={copy.emptyTitle} />
            ) : null}
            {collection.total > 0 && rows.length === 0 ? (
                <Item title={t('common.noMatches')} mode="info" />
            ) : null}
            {collection.groups.map((group, index) => (
                <React.Fragment key={group.id ?? 'loose'}>
                    {collection.groups.length > 1 ? (
                        <CollectionListGroupLabel
                            title={group.title ?? t('promptLibrary.surface.noFolder')}
                            count={group.rows.length}
                            first={index === 0 && route?.kind !== 'draft'}
                        />
                    ) : null}
                    {group.rows.map(renderRow)}
                </React.Fragment>
            ))}
        </CollectionList>
    );
});

/** An empty collection's invitation to add its first item. */
const PromptCollectionEmpty = React.memo(function PromptCollectionEmpty(props: Readonly<{ kind: PromptCollectionKind }>) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const copy = collectionCopy(props.kind);
    return (
        <EmptyState
            testID={`${copy.testID}.empty`}
            variant="add"
            scene={props.kind === 'bundle' ? undefined : 'ideas'}
            icon={<Icon name="plus" size={20} color={theme.colors.text.secondary} />}
            title={copy.emptyTitle}
            subtitle={copy.emptySubtitle}
            action={(
                <RoundButton
                    testID={`${copy.testID}.emptyAdd`}
                    size="small"
                    display="secondary"
                    title={copy.add}
                    onPress={() => openHref(router, promptCollectionDraftHref(props.kind), false, 'PromptCollection.emptyAdd')}
                />
            )}
        />
    );
});

/**
 * A collection's index route. Beside the rail an item is always selected, so it lands on the last
 * opened or the first item (an empty collection invites the first one instead); where no rail shows,
 * the index is the list itself and each row pushes its editor.
 */
export const PromptCollectionIndex = React.memo(function PromptCollectionIndex(props: Readonly<{ kind: PromptCollectionKind }>) {
    const view = useHappierCollectionIndexView();
    if (view === 'pending') return null;
    if (view === 'land') return <PromptCollectionLanding kind={props.kind} />;
    return <PromptCollectionPage kind={props.kind} />;
});

const PromptCollectionLanding = React.memo(function PromptCollectionLanding(props: Readonly<{ kind: PromptCollectionKind }>) {
    const collection = usePromptCollection(props.kind, '');
    const landingId = resolvePromptCollectionLandingId(collection, readLastVisitedPromptCollectionId(props.kind));
    if (landingId) return <Redirect href={promptCollectionItemHref(props.kind, landingId) as never} />;
    return (
        <ItemList>
            <View style={styles.emptyPane}>
                {collection.status === 'ready' && !collection.stale ? (
                    <PromptCollectionEmpty kind={props.kind} />
                ) : (
                    <PromptCollectionReadState kind={props.kind} collection={collection} />
                )}
            </View>
        </ItemList>
    );
});

/** The list as a page, where no rail shows (phones, narrow windows). */
const PromptCollectionPage = React.memo(function PromptCollectionPage(props: Readonly<{ kind: PromptCollectionKind }>) {
    const router = useRouter();
    const copy = collectionCopy(props.kind);
    const [query, setQuery] = React.useState('');
    const collection = usePromptCollection(props.kind, query);
    const rows = collection.groups.flatMap((group) => group.rows);
    return (
        <ItemList keyboardShouldPersistTaps="handled">
            <SettingsPageHeader
                testID={`${copy.testID}.header`}
                description={copy.description}
                actions={<PromptCollectionAddButton kind={props.kind} />}
            />
            <PromptCollectionReadState kind={props.kind} collection={collection} />
            {collection.total > SEARCH_THRESHOLD ? (
                <CompactSearchField
                    testID={`${copy.testID}.search`}
                    value={query}
                    onChangeText={setQuery}
                    placeholder={copy.search}
                    placement="page"
                />
            ) : null}
            {collection.total === 0 ? (
                collection.status === 'ready' && !collection.stale ? (
                    <ItemGroup surface="none">
                        <PromptCollectionEmpty kind={props.kind} />
                    </ItemGroup>
                ) : null
            ) : rows.length === 0 ? (
                <ItemGroup>
                    <Item title={t('common.noMatches')} mode="info" />
                </ItemGroup>
            ) : collection.groups.map((group) => (
                <ItemGroup
                    key={group.id ?? 'loose'}
                    title={collection.groups.length > 1 ? (group.title ?? t('promptLibrary.surface.noFolder')) : undefined}
                >
                    {group.rows.map((row) => (
                        <Item
                            key={row.id}
                            testID={`${copy.testID}.row.${row.id}`}
                            title={row.title}
                            subtitle={row.subtitle}
                            onPress={() => openHref(router, promptCollectionItemHref(props.kind, row.id), false, 'PromptCollectionPage.open')}
                        />
                    ))}
                </ItemGroup>
            ))}
        </ItemList>
    );
});

/**
 * Prompts, skills or templates beside the selected item's editor (wide), or the list pushing each
 * editor (narrow). The editor stack stays mounted across the change, so an open draft keeps its edits.
 */
export const PromptCollectionLayout = React.memo(function PromptCollectionLayout(props: Readonly<{ kind: Exclude<PromptCollectionKind, 'bundle'> }>) {
    const navigator = NAVIGATORS[props.kind];
    const resolveChildRoute = React.useCallback(
        (pathname: string) => resolveSettingsNestedRouteName(navigator, pathname) ?? 'index',
        [navigator],
    );
    return (
        <SettingsCollectionLayout
            navigator={navigator}
            rootPathname={promptCollectionRoot(props.kind)}
            resolveChildRoute={resolveChildRoute}
            rail={<PromptCollectionRail kind={props.kind} />}
            railWidth="standard"
            detailMinWidthPx={PROMPT_DETAIL_MIN_WIDTH_PX}
            testID={`settings-prompts-${props.kind}`}
        />
    );
});

const styles = StyleSheet.create(() => ({
    emptyPane: {
        paddingHorizontal: 24,
        paddingTop: 48,
    },
}));
