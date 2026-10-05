import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { Text } from '@/components/ui/text/Text';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Typography } from '@/constants/Typography';
import { resolveAnchoredListMoveV1 } from '@happier-dev/protocol';
import { HomeHubLayoutIntentSchema } from '@happier-dev/protocol/home';
import { EntityFlatReorderList, EntityFlatReorderRow, settleEntityReorderWrite, entityReorderPreview, entityReorderRefused, type EntityFlatReorderBinding } from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { t } from '@/text';

import { findHomeHubBuiltinSection, homeHubSectionTitle } from '../homeHubSections';
import type { HomeHubSection } from './homeHubLayout';
import { useHomeHubLayout, type HomeHubLayout } from './useHomeHubLayout';

type EditorRow = Readonly<{ id: string; section: HomeHubSection<WidgetCandidate> }>;

/**
 * Customize Home: one list of the built-in sections and the widgets plugins offer, each named with
 * its source. A grip moves a section with drag, staged keyboard or the chooser; a switch shows or
 * hides it; "Start a session" and "Needs your attention" are always shown. Dismissed setup steps
 * come back from the last row. Everything is saved on the Account, so the page behind updates
 * live. Home's Customize popover and Settings → Appearance render this one editor.
 */
export const HomeLayoutEditor = React.memo(function HomeLayoutEditor(props: Readonly<{
    title?: string;
    /** `popover`: Home's Customize popover, headed by its own title, Reset and purpose line. */
    presentation?: 'section' | 'popover';
    /** Opens Add to Home (the shared widget gallery); absent where the editor cannot hand over. */
    onAddWidgets?: () => void;
}>) {
    const layout = useHomeHubLayout();
    const scope = useActiveServerAccountScope();
    const placed = React.useMemo(
        () => layout.sections.map((section) => ({ id: section.id, title: homeHubSectionTitle(section) })),
        [layout.sections],
    );
    const binding: EntityFlatReorderBinding = {
        scope, kind: 'home-section', items: placed,
        getItem: (id) => scope && placed.some(item => item.id === id) ? { kind: 'home-section', scope, sectionId: id } : null,
        getSourceId: (item) => item.kind === 'home-section' ? item.sectionId : null,
        resolve: (sectionId, position) => {
            if (!scope) return entityReorderRefused('reorder_scope_unavailable');
            const ids = placed.map(item => item.id);
            const next = resolveAnchoredListMoveV1(ids, sectionId, position);
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

    const reset = (
        <SectionActionButton
            testID="home-layout.reset"
            title={t('homeIndex.reset')}
            icon="arrow-arc-left"
            disabled={layout.isDefault}
            onPress={layout.reset}
        />
    );
    const popover = props.presentation === 'popover';

    return (
        <>
            {popover ? (
                <View style={styles.popoverHeader}>
                    <View style={styles.popoverTitleRow}>
                        <Text style={styles.popoverTitle} accessibilityRole="header">{t('homeIndex.customizeTitle')}</Text>
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
            {layout.status === 'error' ? (
                <SurfaceStateCard
                    testID="home-layout.save-error"
                    kind="error"
                    size="line"
                    title={t('common.error')}
                    diagnosticCode={layout.errorCode}
                    action={{ label: t('common.retry'), onPress: layout.retry, testID: 'home-layout.retry' }}
                    secondaryAction={layout.canCancelFailedIntent ? {
                        label: t('common.cancel'), onPress: layout.cancelFailedIntent, testID: 'home-layout.cancel',
                    } : undefined}
                    accessibilitySemantics="alert"
                />
            ) : null}
            {props.onAddWidgets ? (
                <Item
                    testID="home-layout.addWidgets"
                    title={t('widgetAdd.addWidgets')}
                    icon={<Icon name="plus" />}
                    onPress={props.onAddWidgets}
                />
            ) : null}
            <EntityFlatReorderList binding={binding} testID="home-layout.reorder" initialOrganizing>
                {rows.map((row, index) => (
                    <EditorRowView
                        key={row.id}
                        row={row}
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
                    onPress={layout.showHiddenSetupSteps}
                />
            ) : null}
        </ItemGroup>
        </>
    );
});

function rowIcon(row: EditorRow): IconName {
    if (row.section.kind === 'widget') return row.section.widget?.icon ?? 'squares-four';
    return findHomeHubBuiltinSection(row.section.id)?.icon ?? 'squares-four';
}

function rowSubtitle(row: EditorRow): string {
    if (row.section.kind === 'widget') return row.section.widget?.pluginName ?? t('sessionBoard.item.pluginUnavailable.title');
    return findHomeHubBuiltinSection(row.section.id)?.description() ?? t('homeIndex.builtIn');
}

function EditorRowView(props: Readonly<{
    row: EditorRow;
    layout: HomeHubLayout;
    showDivider: boolean;
}>) {
    const { theme } = useUnistyles();
    const { row, layout } = props;
    const title = homeHubSectionTitle(row.section);
    const alwaysShown = !row.section.hideable;
    const shown = !row.section.hidden;
    const content = (renderHandle: (testID?: string) => React.ReactNode) => (
            <View style={styles.row}>
                <View style={styles.grip}>{renderHandle(`home-layout.${row.id}.grip`)}</View>
                <View style={styles.item}>
                    <Item
                        testID={`home-layout.${row.id}`}
                        title={title}
                        subtitle={rowSubtitle(row)}
                        icon={<Icon name={rowIcon(row)} />}
                        showChevron={false}
                        showDivider={props.showDivider}
                        rightElement={alwaysShown ? (
                            <View style={styles.locked}>
                                <Icon name="lock" size={12} color={theme.colors.text.tertiary} />
                                <Text style={styles.lockedText}>{t('homeIndex.alwaysShown')}</Text>
                            </View>
                        ) : (
                            <Switch
                                testID={`home-layout.${row.id}.shown`}
                                accessibilityLabel={`${t('settingsOverview.homeShowSection')}: ${title}`}
                                value={shown}
                                onValueChange={(next) => layout.setHidden(row.id, !next)}
                            />
                        )}
                    />
                </View>
            </View>
    );
    return <EntityFlatReorderRow id={row.id}>{({ renderHandle }) => content(renderHandle)}</EntityFlatReorderRow>;
}

const styles = StyleSheet.create((theme) => ({
    popoverHeader: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 4,
        gap: 4,
    },
    popoverTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    popoverTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 15,
        lineHeight: 20,
    },
    popoverDescription: {
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
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
        gap: 4,
    },
    lockedText: {
        color: theme.colors.text.tertiary,
        fontSize: 12,
        lineHeight: 16,
    },
}));
