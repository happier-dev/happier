import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Switch } from '@/components/ui/forms/Switch';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { Text } from '@/components/ui/text/Text';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Typography } from '@/constants/Typography';
import { HomeHubLayoutIntentSchema } from '@happier-dev/protocol/home';
import { EntityFlatReorderList, EntityFlatReorderRow, settleEntityReorderWrite, entityReorderPreview, entityReorderRefused, type EntityFlatReorderBinding } from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { normalizeWidgetSizeForSurfaceV1, resolveWidgetSizeChoicesV1 } from '@happier-dev/protocol/widgets';
import { WidgetSizeControl } from '@/components/widgets/frame/WidgetSizeControl';
import { t } from '@/text';

import { findHomeHubBuiltinSection, homeChildTitle, homeHubSectionTitle } from '../homeHubSections';
import type { HomeHubSection } from './homeHubLayout';
import { useHomeHubLayout, type HomeHubLayout } from './useHomeHubLayout';
import { WIDGET_GROUP_ICON, describeWidgetGroupAmong, widgetGroupCopyPosition } from '@/components/widgets/group/widgetGroupMenu';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { HomeReachabilityGate } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { useHomeHubLayoutWritePending, useHomeHubSectionVisibilityPending } from './useHomeHubArtifactLayout';

type EditorRow = Readonly<{ id: string; section: HomeHubSection<WidgetCandidate> }>;

/**
 * Home's sections as one list: the built-in sections and the widgets plugins offer, each named with
 * its source. A grip moves a section with drag, staged keyboard or the chooser; a switch shows or
 * hides it; "Start a session" and "Needs your attention" are always shown. Dismissed setup steps
 * come back from the last row. Everything is saved on the Account, so the page behind updates
 * live. Home's Customize bar ("Sections") and Settings → Appearance render this one editor.
 *
 * A group is one row here, to reorder. Its name, width and ⋯ belong to its bar on the page.
 */
export const HomeLayoutEditor = React.memo(function HomeLayoutEditor(props: Readonly<{
    title?: string;
    /** `popover`: the list opened from Home's Customize bar, headed by its own title, Reset and purpose line. */
    presentation?: 'section' | 'popover';
}>) {
    const layout = useHomeHubLayout();
    const isWriting = useHomeHubLayoutWritePending();
    const scope = useActiveServerAccountScope();
    // A group's name among the groups that share it, the label its rows, chooser and dock all use.
    const placed = React.useMemo(() => {
        const childTitle = homeChildTitle(layout.sections);
        return layout.sections.map((section) => ({
            id: section.id,
            title: section.kind === 'group' ? describeWidgetGroupAmong(layout.items, section.group, childTitle) : homeHubSectionTitle(section),
        }));
    }, [layout.sections, layout.items]);
    const projectMove: NonNullable<EntityFlatReorderBinding['projectMove']> = (sectionId, position) => {
        try { return layout.projectMove(sectionId, position); }
        catch { return null; }
    };
    const binding: EntityFlatReorderBinding = {
        scope, kind: 'home-section', items: placed,
        getItem: (id) => scope && placed.some(item => item.id === id) ? { kind: 'home-section', scope, sectionId: id } : null,
        getSourceId: (item) => item.kind === 'home-section' ? item.sectionId : null,
        projectMove,
        resolve: (sectionId, position) => {
            if (!scope) return entityReorderRefused('reorder_scope_unavailable');
            const ids = placed.map(item => item.id);
            const next = projectMove(sectionId, position);
            if (!next) return entityReorderRefused('reorder_member_gone');
            if (next.every((id, index) => id === ids[index])) return entityReorderRefused('same-position');
            return { status: 'allowed', effect: { actionId: 'home.hub.layout.update', input: { intent: { kind: 'move_to', sectionId, position } }, preview: entityReorderPreview(position, placed) } };
        },
        execute: async (effect) => {
            if (!scope) return { status: 'refused', reason: { code: 'reorder_scope_unavailable', message: t('entityDragDrop.reasons.gone') } };
            const input = effect.input;
            const intent = HomeHubLayoutIntentSchema.safeParse(input && typeof input === 'object' && 'intent' in input ? input.intent : undefined);
            if (effect.actionId !== 'home.hub.layout.update' || !intent.success || intent.data.kind !== 'move_to') {
                return { status: 'refused', reason: { code: 'reorder_invalid_intent', message: t('entityDragDrop.reasons.gone') } };
            }
            const move = intent.data;
            return settleEntityReorderWrite(() => layout.moveTo(move.sectionId, move.position));
        },
    };
    const rows: EditorRow[] = layout.sections.map((section) => ({ id: section.id, section }));

    // These in-place events keep failures in the mounted queue-owned error/retry controls below.
    const reset = (
        <SectionActionButton
            testID="home-layout.reset"
            title={t('homeIndex.reset')}
            icon="arrow-arc-left"
            disabled={layout.isDefault}
            onPress={() => layout.reset().catch(() => {})}
        />
    );
    const popover = props.presentation === 'popover';

    return (
        <>
            {popover ? (
                <View style={styles.popoverHeader}>
                    <View style={styles.popoverTitleRow}>
                        <Text style={styles.popoverTitle} accessibilityRole="header">{t('homeIndex.sections')}</Text>
                        {reset}
                    </View>
                    <Text style={styles.popoverDescription}>{t('homeIndex.customizeDescription')}</Text>
                </View>
            ) : null}
        <ItemGroup
            // In the popover the rows sit on the popover's own surface, at list density (lab I6).
            {...(popover ? { surface: 'none' as const, density: 'compact' as const } : {
                title: props.title ?? t('homeIndex.customizeTitle'),
                description: t('homeIndex.customizeDescription'),
                action: reset,
            })}
        >
            {isWriting && scope ? <HomeReachabilityGate variant="line" relevantServerIds={[scope.serverId]}>{null}</HomeReachabilityGate> : null}
            {layout.status === 'error' ? (
                <SurfaceStateCard
                    testID="home-layout.save-error"
                    kind="error"
                    size="line"
                    title={resolveActionExecutionFailureMessage({ ok: false, errorCode: layout.errorCode }, t('common.error'))!}
                    diagnosticCode={layout.errorCode}
                    action={{ label: t('common.retry'), onPress: layout.retry, testID: 'home-layout.retry', disabled: isWriting }}
                    secondaryAction={layout.canCancelFailedIntent ? {
                        label: t('common.cancel'), onPress: layout.cancelFailedIntent, testID: 'home-layout.cancel',
                        disabled: isWriting,
                    } : undefined}
                    accessibilitySemantics="alert"
                />
            ) : null}
            <EntityFlatReorderList binding={binding} testID="home-layout.reorder" alwaysOrganizing>
                {rows.map((row, index) => (
                    <EditorRowView
                        key={row.id}
                        row={row}
                        copy={groupCopyOf(rows, row)}
                        layout={layout}
                        showDivider={index < rows.length - 1 || layout.hiddenSetupStepCount > 0}
                    />
                ))}
            </EntityFlatReorderList>
            {layout.hiddenSetupStepCount > 0 ? (
                <Item
                    testID="home-layout.hiddenSetupSteps"
                    title={t('homeIndex.hiddenSetupSteps')}
                    detail={t('homeIndex.showAgain', { count: layout.hiddenSetupStepCount })}
                    showChevron={false}
                    onPress={() => layout.showHiddenSetupSteps().catch(() => {})}
                />
            ) : null}
        </ItemGroup>
        </>
    );
});

function rowIcon(row: EditorRow): IconName {
    if (row.section.kind === 'group') return WIDGET_GROUP_ICON;
    if (row.section.kind === 'widget') return row.section.widget?.icon ?? 'squares-four';
    return findHomeHubBuiltinSection(row.section.id)?.icon ?? 'squares-four';
}

/**
 * Groups placed from one saved group read the same, so a row says which copy it is among those that share
 * its title (in the order Home shows them); a group with a title of its own needs no such mark.
 */
function groupCopyOf(rows: readonly EditorRow[], row: EditorRow): ReturnType<typeof widgetGroupCopyPosition> {
    if (row.section.kind !== 'group') return null;
    return widgetGroupCopyPosition(
        rows.flatMap(other => other.section.kind === 'group' ? [other.section] : []),
        row.section,
        homeHubSectionTitle,
    );
}

function rowSubtitle(row: EditorRow, copy: ReturnType<typeof groupCopyOf>): string {
    if (row.section.kind === 'group') {
        const count = row.section.children.length;
        return copy ? t('widgetFrame.groupCopyOf', { count, ...copy }) : t('widgetFrame.groupCount', { count });
    }
    if (row.section.kind === 'widget') return row.section.widget?.pluginName ?? t('sessionBoard.item.pluginUnavailable.title');
    return findHomeHubBuiltinSection(row.section.id)?.description() ?? t('homeIndex.builtIn');
}

function EditorRowView(props: Readonly<{
    row: EditorRow;
    copy: ReturnType<typeof groupCopyOf>;
    layout: HomeHubLayout;
    showDivider: boolean;
}>) {
    const { theme } = useUnistyles();
    const { row, layout } = props;
    const title = homeHubSectionTitle(row.section);
    const alwaysShown = !row.section.hideable;
    // A pressed switch shows its new value at once and its row waits (the reorder owner's treatment) until the
    // Account acknowledges. A press while one is waiting is ignored: the switch always shows the one intent in
    // flight, so a queued second press can never land later and flip the row back.
    const requestedHidden = useHomeHubSectionVisibilityPending(row.id);
    const pending = requestedHidden !== undefined;
    const shown = !(requestedHidden ?? row.section.hidden);
    const setShown = (next: boolean) => {
        if (pending) return;
        void layout.setHidden(row.id, !next).catch(() => {});
    };
    const sizeChoices = row.section.kind === 'widget' ? resolveWidgetSizeChoicesV1('home', row.section.widget?.sizeDeclaration) : null;
    const size = row.section.kind === 'widget' && row.section.widget && sizeChoices?.defaultSize ? (
        <WidgetSizeControl surface="home" sizes={sizeChoices.sizes}
            size={normalizeWidgetSizeForSurfaceV1('home', row.section.size, row.section.widget?.sizeDeclaration)!}
            onSet={next => { void layout.setSize(row.id, next).catch(() => {}); }}
            testID={`home-layout.${row.id}.size`} />
    ) : null;
    const content = (renderHandle: (testID?: string) => React.ReactNode) => (
        <>
            {/* The grip centres on the row's own title and subtitle, never between the row and its size control. */}
            <View style={styles.row}>
                <View style={styles.grip}>{renderHandle(`home-layout.${row.id}.grip`)}</View>
                <View style={styles.item}>
                    <Item
                        testID={`home-layout.${row.id}`}
                        title={title}
                        subtitle={rowSubtitle(row, props.copy)}
                        icon={<Icon name={rowIcon(row)} />}
                        showChevron={false}
                        showDivider={props.showDivider && size === null}
                        rightElement={alwaysShown ? (
                            // The lock alone: a word here would take the title's room ("Needs your attent…"); hover or
                            // focus says it, and assistive tech reads it.
                            <Tooltip testID={`home-layout.${row.id}.locked`} label={t('homeIndex.alwaysShown')} style={styles.locked}>
                                <Icon name="lock" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
                            </Tooltip>
                        ) : (
                            <Switch
                                testID={`home-layout.${row.id}.shown`}
                                accessibilityLabel={`${t('settingsOverview.homeShowSection')}: ${title}`}
                                value={shown}
                                onValueChange={setShown}
                            />
                        )}
                    />
                </View>
            </View>
            {size ? <View style={[styles.size, props.showDivider ? styles.sizeDivided : null]}>{size}</View> : null}
        </>
    );
    return <EntityFlatReorderRow id={row.id} pending={pending}>{({ renderHandle }) => content(renderHandle)}</EntityFlatReorderRow>;
}

const styles = StyleSheet.create((theme) => ({
    popoverHeader: {
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s4,
        gap: theme.space.s4,
    },
    popoverTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s12,
    },
    popoverTitle: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('sectionTitle'),
        color: theme.colors.text.primary,
    },
    popoverDescription: {
        ...Typography.default(),
        ...happierPageTextMetrics('sectionDescription'),
        color: theme.colors.text.secondary,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    // Under its row, on the row's text column.
    size: {
        paddingLeft: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
        paddingRight: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
        paddingBottom: theme.space.s12,
    },
    sizeDivided: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.subtle,
    },
    grip: {
        alignSelf: 'stretch',
        alignItems: 'center',
        justifyContent: 'center',
    },
    item: {
        flex: 1,
        minWidth: 0,
    },
    locked: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
}));
