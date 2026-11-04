import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { buildWorkBoardItemKeyV1, type BoardItemRefV1 } from '@happier-dev/protocol/boards/workBoardV1';
import type { WidgetInstanceV1, WidgetSizeV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { useAccountWidgetAddSections, type AccountWidgetSurfaceLabels } from '@/components/widgets/add/accountWidgetAddSections';
import { WidgetAddSurface } from '@/components/widgets/add/WidgetAddSurface';
import type { WidgetAddEntry } from '@/components/widgets/add/widgetAddModel';
import type { WidgetSetupCommandResult } from '@/components/widgets/surface/widgetSurfaceSetup';
import { SelectionList, type SelectionListOption, type SelectionListStep } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { joinList } from '@/utils/text/joinList';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { formatWorkflowDefinitionLibraryTitle, formatWorkflowDefinitionContentUnavailableReason } from '@/components/workflows/presentation/workflowProblemPresentation';
import { describeWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { formatWorkflowRunDisplayName, resolveWorkflowRunDisplayName } from '@/components/workflows/presentation/workflowRunDisplayName';
import { Typography } from '@/constants/Typography';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { describeMachinePresenceLine } from '@/utils/sessions/machinePresenceLine';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { getSessionName, getSessionSubtitle } from '@/utils/sessions/sessionUtils';
import { isSessionContentUnsettled } from '@/sync/domains/session/encryptedContentAvailability';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useSessionContentDemand } from '@/sync/domains/session/useSessionContentDemand';

import { useBoardAddSources, type BoardHomes } from '../model/useBoardContent';

/**
 * Add to board (lab `boards-B5`, `dashboards` L1): one search across kinds, anchored to the header's
 * button. Widgets first — the shared Add surface's entries, counted by the copies here, with all of
 * them one row away — then sessions, workflows, workflow runs and machines, grouped by kind, each
 * with one line of context. A work item already on the board says so and is not added twice; ↵ adds,
 * ⌘↵ adds and places it on the Canvas. A widget opens the shared Add surface on it (lab `widget-add`
 * wsplit A): its inputs, its live body at its size, then Add; ⌘↵ on its row also places that Add.
 */

const POPOVER_WIDTH_PX = 480;
const POPOVER_MAX_HEIGHT_PX = 560;
const GALLERY_OPTION_ID = 'widgets:gallery';
const widgetOptionId = (entry: WidgetAddEntry) => `widget:${entry.id}`;

const BOARD_WIDGET_LABELS: AccountWidgetSurfaceLabels = {
    count: (count) => t('widgetAdd.countOnBoard', { count }),
    get submit() { return t('boards.header.add'); },
};

/** The Board as a widget surface: its copies and its one add intent (`widget_add`), with Add and place. */
export type AddToBoardWidgets = Readonly<{
    scope: WidgetSurfaceRefV1 | null;
    instances: readonly WidgetInstanceV1[];
    addInstance: (instance: WidgetInstanceV1, options: Readonly<{ place: boolean; size?: WidgetSizeV1 }>) => Promise<WidgetSetupCommandResult>;
}>;

type AddToBoardControlProps = Readonly<{
    anchorRef: React.RefObject<View | null>;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}>;

/** Only the opener moves into phone navigation; the Board retains the Add surface. */
export const AddToBoardButton = React.memo(function AddToBoardButton(props: AddToBoardControlProps) {
    const { theme } = useUnistyles();
    return <View ref={props.anchorRef} collapsable={false}>
        <RoundButton
            testID="board-header.add"
            display="secondary"
            title={t('boards.header.add')}
            leading={<Icon name="plus" size={ICON_SIZE.sm} color={theme.colors.text.primary} />}
            expanded={props.open}
            onPress={() => props.onOpenChange(!props.open)}
        />
    </View>;
});

export const AddToBoardPopover = React.memo(function AddToBoardPopover(props: AddToBoardControlProps & Readonly<{
    homes: BoardHomes;
    /** Keys of everything on the board now (picked, sections and filter). */
    onBoardKeys: ReadonlySet<string>;
    onAdd: (ref: BoardItemRefV1, options: Readonly<{ place: boolean }>) => void;
    widgets: AddToBoardWidgets;
}>) {
    const { anchorRef } = props;
    const { onOpenChange } = props;
    const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);
    // The shared Add surface: open on everything, or on the widget picked in the list.
    const [gallery, setGallery] = React.useState<Readonly<{ entryId?: string }> | null>(null);
    // ⌘↵ on a widget's row: the Add it leads to also places it.
    const place = React.useRef(false);
    const { addInstance } = props.widgets;
    const addWidget = React.useCallback((instance: WidgetInstanceV1, size?: WidgetSizeV1) => {
        const options = { place: place.current, ...(size ? { size } : {}) };
        place.current = false;
        return addInstance(instance, options);
    }, [addInstance]);
    const pickWidget = React.useCallback((entry: WidgetAddEntry, options: Readonly<{ place: boolean }>) => {
        place.current = options.place;
        close();
        setGallery({ entryId: entry.id });
    }, [close]);
    const openGallery = React.useCallback(() => { close(); place.current = false; setGallery({}); }, [close]);
    const closeGallery = React.useCallback(() => { place.current = false; setGallery(null); }, []);
    return (
        <>
            {props.open ? (
                <Popover
                    open
                    phonePresentation="sheet"
                    accessibilityLabel={t('boards.add.title')}
                    anchorRef={anchorRef}
                    placement="bottom"
                    gap={8}
                    edgePadding={{ horizontal: 8, vertical: 8 }}
                    portal={{ web: true, native: true, matchAnchorWidth: false, anchorAlign: 'end' }}
                    maxWidthCap={POPOVER_WIDTH_PX}
                    maxHeightCap={POPOVER_MAX_HEIGHT_PX}
                    onRequestClose={close}
                >
                    {({ maxHeight, maxWidth }) => (
                        <View testID="board-add.popover">
                            <FloatingOverlay
                                role="panel"
                                maxHeight={Math.min(maxHeight, POPOVER_MAX_HEIGHT_PX)}
                                scrollEnabled={false}
                                surfaceChrome="theme"
                                keyboardShouldPersistTaps="always"
                                containerStyle={{ width: Math.min(maxWidth, POPOVER_WIDTH_PX) }}
                            >
                                <AddToBoardList
                                    homes={props.homes}
                                    onBoardKeys={props.onBoardKeys}
                                    widgets={props.widgets}
                                    addWidget={addWidget}
                                    onPickWidget={pickWidget}
                                    onOpenGallery={openGallery}
                                    maxHeight={Math.min(maxHeight, POPOVER_MAX_HEIGHT_PX)}
                                    onAdd={(ref, options) => { props.onAdd(ref, options); close(); }}
                                    onRequestClose={close}
                                />
                            </FloatingOverlay>
                        </View>
                    )}
                </Popover>
            ) : null}
            {gallery ? (
                <BoardWidgetGallery widgets={props.widgets} addWidget={addWidget} anchorRef={anchorRef}
                    {...(gallery.entryId ? { initialEntryId: gallery.entryId } : {})} onRequestClose={closeGallery} />
            ) : null}
        </>
    );
});

/** The shared Add surface for this Board, mounted only while open. */
function BoardWidgetGallery(props: Readonly<{
    widgets: AddToBoardWidgets;
    addWidget: (instance: WidgetInstanceV1, size?: WidgetSizeV1) => Promise<WidgetSetupCommandResult>;
    anchorRef: React.RefObject<View | null>;
    initialEntryId?: string;
    onRequestClose: () => void;
}>): React.ReactElement {
    const { sections, pendingSections } = useAccountWidgetAddSections({ scope: props.widgets.scope, instances: props.widgets.instances,
        addInstance: props.addWidget, labels: BOARD_WIDGET_LABELS, testID: 'board-add.gallery' });
    return (
        <WidgetAddSurface
            open
            anchorRef={props.anchorRef}
            onRequestClose={props.onRequestClose}
            title={t('boards.header.add')}
            hint={t('boards.widgets.addHint')}
            searchPlaceholder={t('widgetAdd.searchWidgets')}
            addLabel={t('boards.header.add')}
            sections={sections}
            pendingSections={pendingSections}
            {...(props.initialEntryId ? { initialEntryId: props.initialEntryId } : {})}
            {...(props.widgets.scope ? { serverId: props.widgets.scope.serverId } : {})}
            testID="board-add.gallery"
        />
    );
}

/** Mounted only while the popover is open, so a closed header reads nothing. */
const AddToBoardList = React.memo(function AddToBoardList(props: Readonly<{
    homes: BoardHomes;
    onBoardKeys: ReadonlySet<string>;
    widgets: AddToBoardWidgets;
    addWidget: (instance: WidgetInstanceV1, size?: WidgetSizeV1) => Promise<WidgetSetupCommandResult>;
    onPickWidget: (entry: WidgetAddEntry, options: Readonly<{ place: boolean }>) => void;
    onOpenGallery: () => void;
    maxHeight: number;
    onAdd: (ref: BoardItemRefV1, options: Readonly<{ place: boolean }>) => void;
    onRequestClose: () => void;
}>) {
    const { theme } = useUnistyles();
    const { rowsByServerId, machineLists, library, runs, loading } = useBoardAddSources(props.homes);
    // The Sessions it offers are named from encrypted content: the undecided ones are demanded like list rows.
    const undecidedSessions = React.useMemo(() => Object.entries(rowsByServerId).flatMap(([serverId, rows]) => (
        Object.values(rows ?? {}).filter(row => typeof row.archivedAt !== 'number' && isSessionContentUnsettled(row))
            .map((row): SessionAddress => ({ serverId, sessionId: row.id }))
    )), [rowsByServerId]);
    useSessionContentDemand(undecidedSessions, { tag: 'board.hydrateAddSessions', hydrate: 'unsettled' });
    const openingGroups = (['sessions', 'workflows', 'runs', 'machines'] as const).filter(group => loading[group]);
    const reachabilityRevision = useMachineReachabilityRevision();
    const machineScopeBindings = useServerCredentialAccountScopeBindings(Object.keys(machineLists));
    const presenceMachines = React.useMemo(() => Object.values(machineLists).flatMap(list => list ?? []), [machineLists]);
    const presenceNowMs = useMachinePresenceNowMs(presenceMachines);
    const activeServerId = props.homes.activeServerId;
    const refsRef = React.useRef(new Map<string, BoardItemRefV1>());
    const widgetsRef = React.useRef(new Map<string, WidgetAddEntry>());
    const { sections: widgetSections } = useAccountWidgetAddSections({ scope: props.widgets.scope, instances: props.widgets.instances,
        addInstance: props.addWidget, labels: BOARD_WIDGET_LABELS, testID: 'board-add.widgets' });

    const step = React.useMemo<SelectionListStep>(() => {
        const nowMs = Date.now();
        const refsById = new Map<string, BoardItemRefV1>();
        const onBoardMark = (
            <View style={styles.onBoard}>
                <Icon name="check" size={14} color={theme.colors.text.tertiary} />
                <Text style={styles.onBoardText}>{t('boards.add.onBoard')}</Text>
            </View>
        );
        const option = (ref: BoardItemRefV1, label: string, subtitle: string | undefined, icon: React.ReactNode): SelectionListOption => {
            const key = buildWorkBoardItemKeyV1(ref);
            refsById.set(key, ref);
            const onBoard = props.onBoardKeys.has(key);
            return {
                id: key,
                label,
                ...(subtitle ? { subtitle } : {}),
                icon,
                ...(onBoard ? { rightAccessory: onBoardMark, disabled: true } : {}),
            };
        };
        const glyph = (name: IconName) => (
            <Icon name={name} size={16} color={theme.colors.text.secondary} />
        );

        // Widgets: the Add surface's own entries (its counts and Added), then the surface itself. A short
        // group leads (lab `dashboards` L1): the built-in families with pages of their own (Machines,
        // Usage) stay one row away through Gallery, and a search still finds them here.
        const widgetEntries = new Map<string, WidgetAddEntry>();
        const widgetOption = (entry: WidgetAddEntry): SelectionListOption => {
            widgetEntries.set(widgetOptionId(entry), entry);
            const where = entry.count ?? (entry.added ? t('boards.add.onBoard') : null);
            const subtitle = [entry.subtitle, where].filter(Boolean).join(' · ');
            return {
                id: widgetOptionId(entry),
                label: entry.title,
                ...(subtitle ? { subtitle } : {}),
                icon: glyph(entry.icon),
                ...(entry.added ? { rightAccessory: onBoardMark, disabled: true } : {}),
            };
        };
        const widgets = widgetSections.filter(section => !section.family).flatMap(section => section.entries).map(widgetOption);
        const familyWidgets = widgetSections.filter(section => section.family).flatMap(section => section.entries).map(widgetOption);
        widgets.push({
            id: GALLERY_OPTION_ID,
            label: t('boards.widgets.gallery'),
            subtitle: t('boards.widgets.galleryHint'),
            icon: glyph('squares-four'),
        });
        widgetsRef.current = widgetEntries;

        const sessions: SelectionListOption[] = [];
        for (const [serverId, rows] of Object.entries(rowsByServerId)) {
            const portable = resolveServerProfileScopeIdForIdentifier(serverId) || serverId;
            for (const row of Object.values(rows ?? {})) {
                if (typeof row.archivedAt === 'number') continue;
                sessions.push(option(
                    { kind: 'session', qualifiedId: { serverId: portable, id: row.id } },
                    getSessionName(row, serverId),
                    getSessionSubtitle(row, serverId),
                    glyph('chat-circle'),
                ));
            }
        }
        const workflows = activeServerId ? library.definitions.map((definition) => option(
            { kind: 'workflow', qualifiedId: { serverId: activeServerId, id: definition.definitionId } },
            formatWorkflowDefinitionLibraryTitle(definition),
            definition.contentStatus === 'unavailable'
                ? formatWorkflowDefinitionContentUnavailableReason(definition.contentUnavailableReason)
                : definition.metadata.description,
            glyph('clock'),
        )) : [];
        const workflowRuns = activeServerId ? runs.rows.flatMap((row) => (row.summary ? [option(
            { kind: 'workflow_run', qualifiedId: { serverId: activeServerId, id: row.id } },
            formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(row.metadata)),
            `${describeWorkflowRunState(row.summary.state).label} · ${formatRelativeTimeShort(Date.parse(row.summary.createdAt), nowMs)}`,
            glyph('tree-structure'),
        )] : [])) : [];
        const machines: SelectionListOption[] = [];
        for (const [serverId, list] of Object.entries(machineLists)) {
            const portable = resolveServerProfileScopeIdForIdentifier(serverId) || serverId;
            const binding = machineScopeBindings.get(portable);
            for (const machine of list ?? []) {
                machines.push(option(
                    { kind: 'machine', qualifiedId: { serverId: portable, id: machine.id } },
                    getMachineDisplayName(machine),
                    describeMachinePresenceLine(machine, presenceNowMs, undefined, binding?.isCurrent() ? binding.scope : null).label,
                    glyph('hard-drives'),
                ));
            }
        }
        refsRef.current = refsById;
        return {
            id: 'board-add',
            inputPlaceholder: t('boards.add.search'),
            emptyStateLabel: t('boards.add.empty'),
            // Typed and found nothing: say what was searched and clear it in place, as the Home gallery does.
            emptyStateForQuery: (query) => ({ label: t('boards.add.noMatch', { query }), clearLabel: t('selectionList.clearInput') }),
            footerHints: [
                { id: 'add', label: '↵', description: t('boards.add.addHint') },
                { id: 'add-and-place', label: '⌘↵', description: t('boards.add.addAndPlaceHint') },
            ],
            sections: [
                { kind: 'static', id: 'widgets', title: t('boards.widgets.group'), options: widgets },
                {
                    kind: 'dynamic', id: 'widgets-more',
                    resolverKey: JSON.stringify(familyWidgets.map(option => [option.id, option.subtitle, option.disabled === true])),
                    visibleWhen: (input) => input.trim().length > 0,
                    debounceMs: 0, loadingSkeletonRows: 0, resultTransition: 'none',
                    resolve: async () => ({ options: familyWidgets }),
                },
                { kind: 'static', id: 'sessions', title: t('boards.add.groups.sessions'), options: sessions, virtualization: 'auto' },
                { kind: 'static', id: 'workflows', title: t('boards.add.groups.workflows'), options: workflows },
                { kind: 'static', id: 'runs', title: t('boards.add.groups.runs'), options: workflowRuns },
                { kind: 'static', id: 'machines', title: t('boards.add.groups.machines'), options: machines },
            ],
        };
    }, [activeServerId, library.definitions, machineLists, machineScopeBindings, presenceNowMs, reachabilityRevision, props.onBoardKeys, rowsByServerId, runs.rows, theme.colors.text.secondary, theme.colors.text.tertiary, widgetSections]);
    const { onAdd, onPickWidget, onOpenGallery } = props;
    const select = React.useCallback((id: string, place: boolean) => {
        if (id === GALLERY_OPTION_ID) { onOpenGallery(); return; }
        const widget = widgetsRef.current.get(id);
        if (widget) { onPickWidget(widget, { place }); return; }
        const ref = refsRef.current.get(id);
        if (ref) onAdd(ref, { place });
    }, [onAdd, onOpenGallery, onPickWidget]);
    const onSelect = React.useCallback((id: string) => select(id, false), [select]);
    // ⌘↵ / Ctrl+↵: add it and place it on the Canvas.
    const onCommandSelect = React.useCallback((id: string) => select(id, true), [select]);

    return (
        <SelectionList
            testID="board-add.list"
            rootStep={step}
            pagination={runs.hasMore || runs.loadingMore || runs.loadMoreFailed ? {
                hasMore: runs.hasMore,
                loadingMore: runs.loadingMore,
                requestKey: JSON.stringify([activeServerId, runs.knownAt, runs.runIds.at(-1)]),
                error: runs.loadMoreFailed ? t('workflows.loadFailedBody') : null,
                onEndReached: runs.loadMore,
                onRetry: runs.loadMore,
                loadingLabel: t('common.loading'),
                moreLabel: t('common.more'),
                retryLabel: t('common.retry'),
                endReachedLabel: t('common.done'),
            } : undefined}
            bodyHeader={openingGroups.length > 0 || library.status === 'failed' || runs.status === 'failed' ? (
                <View style={styles.failures}>
                    {/* One line names every group still opening and narrows as each settles. */}
                    {openingGroups.length > 0 ? (
                        <SurfaceStateCard testID="board-add.loading" size="line" kind="loading"
                            title={t('surfaceState.opening', { name: joinList(openingGroups.map(group => t(`boards.add.groups.${group}`))) })}
                            accessibilitySemantics="status" />
                    ) : null}
                    {library.status === 'failed' ? (
                        <SurfaceStateCard
                            testID="board-add.workflows-failure"
                            size="line"
                            kind="error"
                            title={t('boards.add.groups.workflows')}
                            reason={library.failure?.message}
                            diagnosticCode={library.failure?.code}
                            accessibilitySemantics={library.failure?.accessibilitySemantics}
                            action={{ label: t('common.retry'), onPress: library.retry, testID: 'board-add.workflows-failure.retry' }}
                        />
                    ) : null}
                    {runs.status === 'failed' ? (
                        <SurfaceStateCard
                            testID="board-add.runs-failure"
                            size="line"
                            kind="error"
                            title={t('boards.add.groups.runs')}
                            reason={runs.failure?.message}
                            diagnosticCode={runs.failure?.code}
                            accessibilitySemantics={runs.failure?.accessibilitySemantics}
                            action={{ label: t('common.retry'), onPress: runs.retry, testID: 'board-add.runs-failure.retry' }}
                        />
                    ) : null}
                </View>
            ) : undefined}
            listAccessibilityLabel={t('boards.add.title')}
            autoFocusInputOnWeb
            // The panel keeps its size while a search narrows the rows (nothing resizes under the pointer).
            heightBehavior="fixedToMaxHeight"
            maxHeight={props.maxHeight}
            onSelect={onSelect}
            onCommandSelect={onCommandSelect}
            onRequestClose={props.onRequestClose}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    failures: {
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s8,
        gap: theme.space.s8,
    },
    onBoard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    onBoardText: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
}));
