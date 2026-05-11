import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { PinIcon, PinSlashIcon } from '@/components/sessions/shell/sessionPinIcons';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { DetailsTabState, DetailsWorkspaceGroupView } from './detailsWorkspaceTypes';

type ScrollPropagationEvent = Readonly<{ stopPropagation?: () => void }>;

export type DetailsTabStripTestIds = Readonly<{
    tab?: (tabKey: string) => string | null | undefined;
    tabPin?: (tabKey: string) => string | null | undefined;
    tabUnpin?: (tabKey: string) => string | null | undefined;
    tabClose?: (tabKey: string) => string | null | undefined;
}>;

export type DetailsTabStripProps = Readonly<{
    pane: AppPaneScopeApi;
    group: DetailsWorkspaceGroupView;
    resolveTabIconName?: ((tab: DetailsTabState) => string | null | undefined) | null;
    testIds?: DetailsTabStripTestIds;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    tabsScroll: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    tab: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        paddingRight: 52,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        maxWidth: 220,
    },
    tabActive: {
        backgroundColor: theme.colors.surface.inset,
    },
    tabLabel: {
        flexShrink: 1,
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
    tabLabelActive: {
        color: theme.colors.text.primary,
    },
    tabCopy: {
        flex: 1,
        minWidth: 0,
        gap: 1,
    },
    tabSubtitle: {
        fontSize: 10,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    tabActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
}));

export const DetailsTabStrip = React.memo((props: DetailsTabStripProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    return (
        <ScrollView horizontal style={styles.tabsScroll} showsHorizontalScrollIndicator={false}>
            {props.group.tabs.map((tab) => {
                const isActive = props.group.activeTabKey ? tab.key === props.group.activeTabKey : false;
                const safeTabKey = toTestIdSafeValue(tab.key);
                const iconName =
                    props.resolveTabIconName?.(tab)
                    ?? (
                        tab.kind === 'commit'
                            ? 'git-commit'
                            : tab.kind === 'file'
                                ? 'file'
                                : tab.kind === 'scmReview'
                                    ? 'diff'
                                    : tab.kind === 'scmStash'
                                        ? 'archive'
                                        : tab.kind === 'terminal'
                                            ? 'terminal'
                                            : tab.kind === 'executionRunLauncher'
                                                ? 'play'
                                                : 'circle'
                    );

                return (
                    <View
                        key={tab.key}
                        style={{
                            position: 'relative',
                            marginRight: 8,
                            maxWidth: 220,
                            flexShrink: 0,
                        }}
                    >
                        <Pressable
                            onPress={() => props.pane.setActiveDetailsTab(tab.key)}
                            testID={props.testIds?.tab?.(safeTabKey) ?? undefined}
                            style={[
                                styles.tab,
                                isActive ? styles.tabActive : null,
                                { paddingRight: tab.isPreview || tab.isPinned ? 52 : 34 },
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel={t('session.detailsPanel.openTabA11y', { title: tab.title })}
                        >
                            {tab.kind === 'file' ? (
                                <FileIcon
                                    fileName={tab.title}
                                    size={14}
                                    testID={`session-details-tab-file-icon-${safeTabKey}`}
                                />
                            ) : (
                                <Octicons
                                    name={iconName as React.ComponentProps<typeof Octicons>['name']}
                                    size={14}
                                    color={theme.colors.text.secondary}
                                />
                            )}
                            <View style={styles.tabCopy}>
                                <Text
                                    style={[styles.tabLabel, isActive ? styles.tabLabelActive : null]}
                                    numberOfLines={1}
                                >
                                    {tab.title}
                                </Text>
                                {typeof tab.subtitle === 'string' && tab.subtitle.trim().length > 0 ? (
                                    <Text style={styles.tabSubtitle} numberOfLines={1}>
                                        {tab.subtitle}
                                    </Text>
                                ) : null}
                            </View>
                        </Pressable>
                        <View
                            style={[
                                styles.tabActions,
                                { position: 'absolute', right: 10, top: 0, bottom: 0, zIndex: 1 },
                            ]}
                        >
                            {tab.isPreview ? (
                                <Pressable
                                    onPress={(event: unknown) => {
                                        if (event && typeof (event as ScrollPropagationEvent).stopPropagation === 'function') {
                                            (event as ScrollPropagationEvent).stopPropagation?.();
                                        }
                                        props.pane.pinDetailsTab(tab.key);
                                    }}
                                    testID={props.testIds?.tabPin?.(safeTabKey) ?? undefined}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('session.detailsPanel.pinTabA11y')}
                                    hitSlop={10}
                                >
                                    <PinIcon size={14} color={theme.colors.text.secondary} />
                                </Pressable>
                            ) : tab.isPinned ? (
                                <Pressable
                                    onPress={(event: unknown) => {
                                        if (event && typeof (event as ScrollPropagationEvent).stopPropagation === 'function') {
                                            (event as ScrollPropagationEvent).stopPropagation?.();
                                        }
                                        props.pane.unpinDetailsTab(tab.key);
                                    }}
                                    testID={props.testIds?.tabUnpin?.(safeTabKey) ?? undefined}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('session.detailsPanel.unpinTabA11y')}
                                    hitSlop={10}
                                >
                                    <PinSlashIcon size={14} color={theme.colors.text.secondary} />
                                </Pressable>
                            ) : null}
                            <Pressable
                                onPress={(event: unknown) => {
                                    if (event && typeof (event as ScrollPropagationEvent).stopPropagation === 'function') {
                                        (event as ScrollPropagationEvent).stopPropagation?.();
                                    }
                                    props.pane.closeDetailsTab(tab.key);
                                }}
                                testID={props.testIds?.tabClose?.(safeTabKey) ?? undefined}
                                accessibilityRole="button"
                                accessibilityLabel={t('session.detailsPanel.closeTabA11y')}
                                hitSlop={10}
                            >
                                <Octicons name="x" size={13} color={theme.colors.text.secondary} />
                            </Pressable>
                        </View>
                    </View>
                );
            })}
        </ScrollView>
    );
});
