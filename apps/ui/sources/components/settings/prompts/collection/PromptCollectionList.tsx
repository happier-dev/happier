import * as React from 'react';
import { View } from 'react-native';
import { Redirect, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';
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
import { useArtifacts } from '@/sync/domains/state/storage';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
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
    createHappierCollectionDraftTitleStore,
    useHappierCollectionIndexView,
    useHappierCollectionLayout,
} from '@happier-dev/plugin-ui/presentation';

/** The collection offers a search field only once it no longer fits at a glance. */
const SEARCH_THRESHOLD = 8;
/** Rail width at normal text scale: a name and, for templates, a slash command. */
const PROMPT_RAIL_WIDTH_PX = 260;
/** The narrowest editor that still fits a field beside its label. */
const PROMPT_DETAIL_MIN_WIDTH_PX = 480;

const NAVIGATORS: Readonly<Record<PromptCollectionKind, SettingsNestedNavigator>> = {
    doc: 'prompts/docs',
    bundle: 'prompts/skills',
    template: 'prompts/templates',
};

/** The name typed into each collection's open draft, shown by its draft row. */
const draftTitles: Readonly<Record<PromptCollectionKind, ReturnType<typeof createHappierCollectionDraftTitleStore>>> = {
    doc: createHappierCollectionDraftTitleStore(),
    bundle: createHappierCollectionDraftTitleStore(),
    template: createHappierCollectionDraftTitleStore(),
};

export function publishPromptCollectionDraftTitle(kind: PromptCollectionKind, title: string): void {
    draftTitles[kind].publish(title);
}

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
export function usePromptCollection(kind: PromptCollectionKind, query: string): PromptCollection {
    const artifacts = useArtifacts();
    const { value: folders } = usePromptLibraryCatalogValue('folders');
    const { value: invocations } = usePromptLibraryCatalogValue('invocations');
    const untitled = kind === 'doc' ? t('promptLibrary.untitledPrompt') : t('promptLibrary.untitledSkill');
    return React.useMemo(() => (kind === 'template'
        ? buildPromptTemplateCollection({ invocations, query })
        : buildPromptLibraryCollection({ kind, artifacts, folders, query, untitledTitle: untitled })),
    [artifacts, folders, invocations, kind, query, untitled]);
}

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
    const copy = collectionCopy(props.kind);
    return (
        <CollectionDraftRow
            testID={`${copy.testID}.draft`}
            titles={draftTitles[props.kind]}
            placeholder={copy.draft}
            mark={null}
        />
    );
});

/** The rail beside a prompt, skill or template: name-only rows, grouped by folder when any item has one. */
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
            count={collection.total}
            headerAction={<PromptCollectionAddButton kind={props.kind} />}
            search={collection.total > SEARCH_THRESHOLD ? {
                testID: `${copy.testID}.search`,
                value: query,
                onChangeText: setQuery,
                placeholder: copy.search,
            } : null}
        >
            {route?.kind === 'draft' ? <PromptCollectionDraftRow kind={props.kind} /> : null}
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
                <PromptCollectionEmpty kind={props.kind} />
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
                <ItemGroup surface="none">
                    <PromptCollectionEmpty kind={props.kind} />
                </ItemGroup>
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
export const PromptCollectionLayout = React.memo(function PromptCollectionLayout(props: Readonly<{ kind: PromptCollectionKind }>) {
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
            railWidthPx={PROMPT_RAIL_WIDTH_PX}
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
