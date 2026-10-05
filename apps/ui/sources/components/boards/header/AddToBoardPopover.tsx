import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { buildWorkBoardItemKeyV1, type BoardItemRefV1, type WorkBoardV1 } from '@happier-dev/protocol';
import type { WidgetInstanceV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { useAccountWidgetAddSections, type AccountWidgetSurfaceLabels } from '@/components/widgets/add/accountWidgetAddSections';
import { WidgetAddPopover, WidgetSetupPopover } from '@/components/widgets/add/WidgetAddPopover';
import { resolveWidgetAddPick, type WidgetAddEntry } from '@/components/widgets/add/widgetAddModel';
import type { WidgetSetup } from '@/components/widgets/add/widgetSetupModel';
import { SelectionList, type SelectionListOption, type SelectionListStep } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { formatRelativeTimeShort } from '@/components/ui/selectionList/formatRelativeTimeShort';
import { useWorkflowDefinitionLibrary, useWorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';
import { describeWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { formatWorkflowRunDisplayName, resolveWorkflowRunDisplayName } from '@/components/workflows/presentation/workflowRunDisplayName';
import { Typography } from '@/constants/Typography';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useMachineListByServerId, useSessionListRowsByServerId } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { getMachineDisplayName, isMachineOnline } from '@/utils/sessions/machineUtils';
import { getSessionName, getSessionSubtitle } from '@/utils/sessions/sessionUtils';

import type { BoardHomes } from '../model/useBoardContent';

/**
 * Add to board (lab `boards-B5`, `dashboards` L1): one search across kinds, anchored to the header's
 * button. Widgets first — the shared gallery's entries, counted by the copies here, with the Gallery
 * one row away — then sessions, workflows, workflow runs and machines, grouped by kind, each with one
 * line of context. A work item already on the board says so and is not added twice; ↵ adds, ⌘↵ adds
 * and places it on the Canvas. A widget with missing inputs opens the shared Set up step.
 */

const POPOVER_WIDTH_PX = 480;
const POPOVER_MAX_HEIGHT_PX = 560;
const GALLERY_OPTION_ID = 'widgets:gallery';
const widgetOptionId = (entry: WidgetAddEntry) => `widget:${entry.id}`;

const BOARD_WIDGET_LABELS: AccountWidgetSurfaceLabels = {
    count: (count) => t('widgetAdd.countOnBoard', { count }),
    get submit() { return t('boards.header.add'); },
    get fromPluginsHint() { return t('widgetAdd.homeFromPluginsHint'); },
};

/** The Board as a widget surface: its copies and its one add intent (`widget_add`), with Add and place. */
export type AddToBoardWidgets = Readonly<{
    scope: WidgetSurfaceRefV1 | null;
    instances: readonly WidgetInstanceV1[];
    addInstance: (instance: WidgetInstanceV1, options: Readonly<{ place: boolean }>) => Promise<unknown>;
}>;

export const AddToBoardButton = React.memo(function AddToBoardButton(props: Readonly<{
    board: WorkBoardV1;
    homes: BoardHomes;
    /** Keys of everything on the board now (picked, sections and filter). */
    onBoardKeys: ReadonlySet<string>;
    onAdd: (ref: BoardItemRefV1, options: Readonly<{ place: boolean }>) => void;
    widgets: AddToBoardWidgets;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}>) {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View>(null);
    const { onOpenChange } = props;
    const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);
    const [galleryOpen, setGalleryOpen] = React.useState(false);
    const [setup, setSetup] = React.useState<WidgetSetup | null>(null);
    // ⌘↵ on a widget: the add it leads to (now, or when its Set up step is done) also places it.
    const place = React.useRef(false);
    const { addInstance } = props.widgets;
    const addWidget = React.useCallback((instance: WidgetInstanceV1) => {
        const options = { place: place.current };
        place.current = false;
        return addInstance(instance, options);
    }, [addInstance]);
    const pickWidget = React.useCallback((entry: WidgetAddEntry, options: Readonly<{ place: boolean }>) => {
        const decision = resolveWidgetAddPick(entry);
        if (decision.kind === 'added') return;
        place.current = options.place;
        close();
        if (decision.kind === 'setup') setSetup(decision.setup);
        else if (decision.kind === 'submit') void decision.setup.submit(decision.setup.initial);
        else entry.onPick();
    }, [close]);
    const openGallery = React.useCallback(() => { close(); setGalleryOpen(true); }, [close]);
    const closeSetup = React.useCallback(() => { place.current = false; setSetup(null); }, []);
    return (
        <View ref={anchorRef} collapsable={false}>
            <RoundButton
                testID="board-header.add"
                size="small"
                display="secondary"
                title={t('boards.header.add')}
                leading={<Icon name="plus" size={ICON_SIZE.sm} color={theme.colors.text.primary} />}
                expanded={props.open}
                onPress={() => onOpenChange(!props.open)}
            />
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
            {galleryOpen ? (
                <BoardWidgetGallery widgets={props.widgets} addWidget={addWidget} anchorRef={anchorRef} onRequestClose={() => setGalleryOpen(false)} />
            ) : null}
            {setup ? (
                <WidgetSetupPopover
                    open
                    anchorRef={anchorRef}
                    setup={() => setup}
                    onRequestClose={closeSetup}
                    {...(props.widgets.scope ? { serverId: props.widgets.scope.serverId } : {})}
                    testID="board-add.setup"
                />
            ) : null}
        </View>
    );
});

/** The shared Gallery | List popover for this Board, mounted only while open. */
function BoardWidgetGallery(props: Readonly<{
    widgets: AddToBoardWidgets;
    addWidget: (instance: WidgetInstanceV1) => Promise<unknown>;
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
}>): React.ReactElement {
    const sections = useAccountWidgetAddSections({ scope: props.widgets.scope, instances: props.widgets.instances,
        addInstance: props.addWidget, labels: BOARD_WIDGET_LABELS, testID: 'board-add.gallery' });
    return (
        <WidgetAddPopover
            open
            anchorRef={props.anchorRef}
            onRequestClose={props.onRequestClose}
            title={t('boards.header.add')}
            hint={t('boards.widgets.addHint')}
            searchPlaceholder={t('widgetAdd.searchWidgets')}
            sections={sections}
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
    addWidget: (instance: WidgetInstanceV1) => Promise<unknown>;
    onPickWidget: (entry: WidgetAddEntry, options: Readonly<{ place: boolean }>) => void;
    onOpenGallery: () => void;
    maxHeight: number;
    onAdd: (ref: BoardItemRefV1, options: Readonly<{ place: boolean }>) => void;
    onRequestClose: () => void;
}>) {
    const { theme } = useUnistyles();
    const rowsByServerId = useSessionListRowsByServerId(props.homes.mountedServerIds);
    const machineLists = useMachineListByServerId();
    const library = useWorkflowDefinitionLibrary();
    const runs = useWorkflowRunWindow('all');
    const activeServerId = props.homes.activeServerId;
    const refsRef = React.useRef(new Map<string, BoardItemRefV1>());
    const widgetsRef = React.useRef(new Map<string, WidgetAddEntry>());
    const widgetSections = useAccountWidgetAddSections({ scope: props.widgets.scope, instances: props.widgets.instances,
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

        // Widgets: the gallery's own entries (its counts, Added and Set up), then the Gallery itself.
        const widgetEntries = new Map<string, WidgetAddEntry>();
        const widgets: SelectionListOption[] = widgetSections.flatMap(section => section.entries).map((entry) => {
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
        });
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
            definition.metadata.title,
            definition.metadata.description,
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
            for (const machine of list ?? []) {
                machines.push(option(
                    { kind: 'machine', qualifiedId: { serverId: portable, id: machine.id } },
                    getMachineDisplayName(machine),
                    isMachineOnline(machine, nowMs) ? t('boards.card.machine.online') : t('boards.card.machine.offline'),
                    glyph('hard-drives'),
                ));
            }
        }
        refsRef.current = refsById;
        return {
            id: 'board-add',
            inputPlaceholder: t('boards.add.search'),
            emptyStateLabel: t('boards.add.empty'),
            footerHints: [
                { id: 'add', label: '↵', description: t('boards.add.addHint') },
                { id: 'add-and-place', label: '⌘↵', description: t('boards.add.addAndPlaceHint') },
            ],
            sections: [
                { kind: 'static', id: 'widgets', title: t('boards.widgets.group'), options: widgets },
                { kind: 'static', id: 'sessions', title: t('boards.add.groups.sessions'), options: sessions, virtualization: 'auto' },
                { kind: 'static', id: 'workflows', title: t('boards.add.groups.workflows'), options: workflows },
                { kind: 'static', id: 'runs', title: t('boards.add.groups.runs'), options: workflowRuns },
                { kind: 'static', id: 'machines', title: t('boards.add.groups.machines'), options: machines },
            ],
        };
    }, [activeServerId, library.definitions, machineLists, props.onBoardKeys, rowsByServerId, runs.rows, theme.colors.text.secondary, theme.colors.text.tertiary, widgetSections]);
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
            bodyHeader={library.status === 'failed' || runs.status === 'failed' ? (
                <View style={styles.failures}>
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
            maxHeight={props.maxHeight}
            onSelect={onSelect}
            onCommandSelect={onCommandSelect}
            onRequestClose={props.onRequestClose}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    failures: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 8,
    },
    onBoard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    onBoardText: {
        ...Typography.rowMeta(),
        color: theme.colors.text.tertiary,
    },
}));
