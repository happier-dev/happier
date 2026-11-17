import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { RIGHT_SIDEBAR_BUILTIN_TABS } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { useSessionWorkSources } from '@/components/sessions/work/sessionWorkSources';
import { readWorkSummaryPresentation } from '@/components/sessions/work/workProjection';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { resolveGitTabBadge } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { Text } from '@/components/ui/text/Text';
import { WidgetFrame, type WidgetFrameStyle } from '@/components/widgets/frame/WidgetFrame';
import { Typography } from '@/constants/Typography';
import { useSessionProjectScmStatus, useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    title: { ...Typography.default('semiBold'), ...happierPageTextMetrics('sectionTitle'), color: theme.colors.text.primary },
    fact: { ...Typography.default(), ...Typography.tabular(), ...happierPageTextMetrics('meta'), color: theme.colors.text.tertiary },
    chevron: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: theme.space.s4, alignSelf: 'stretch' },
}));

/** A link row has no body; the header is the whole row. */
const NO_BODY = Object.freeze({ paddingBottom: 0 });

/**
 * A pane in the Companion (lab WC3, bounded C3): one link row — the pane's mark, its name, the one
 * fact its rail badge already carries, and a chevron — that opens the pane. No nested scroller and
 * no second set of pane controls; the row's own ⋯ (reorder, remove) is the placement's.
 */
export const PaneLinkRowView = React.memo(function PaneLinkRowView(props: Readonly<{
    label: string;
    icon: IconName;
    fact?: string | null;
    frameStyle: WidgetFrameStyle;
    menu?: React.ReactNode;
    onOpen?: () => void;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    return (
        <WidgetFrame
            testID={props.testID}
            frameStyle={props.frameStyle}
            placement="companion"
            mark={props.icon}
            title={(
                <Pressable
                    testID={`${props.testID}.open`}
                    accessibilityRole="link"
                    accessibilityLabel={props.fact
                        ? `${t('widgetGlances.paneLinkA11y', { pane: props.label })} ${props.fact}`
                        : t('widgetGlances.paneLinkA11y', { pane: props.label })}
                    onPress={props.onOpen}
                    disabled={!props.onOpen}
                >
                    <Text style={styles.title} numberOfLines={1}>{props.label}</Text>
                </Pressable>
            )}
            {...(props.fact ? { source: <Text style={styles.fact} numberOfLines={1}>{props.fact}</Text> } : {})}
            meta={(
                <Pressable
                    onPress={props.onOpen}
                    disabled={!props.onOpen}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={styles.chevron}
                >
                    <Icon name="caret-right" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
                </Pressable>
            )}
            menu={props.menu}
            bodyStyle={NO_BODY}
            body={{ kind: 'content', children: null }}
        />
    );
});

function builtinPane(paneId: string) {
    return RIGHT_SIDEBAR_BUILTIN_TABS.find((tab) => tab.id === paneId) ?? null;
}

/** What a pane link is called: the rail's own label for the pane. */
export function sessionCompanionPaneLabel(paneId: string): string {
    const tab = builtinPane(paneId);
    return tab ? t(tab.labelKey) : paneId;
}

/**
 * The one fact the pane's rail badge carries, read from the same owners the rail reads: the Git
 * badge model (count or diff, per the person's badge setting) and the Work projection's summary
 * presentation. Other panes carry no badge, so their row carries no fact.
 */
function usePaneRailFact(paneId: string, sessionId: string, serverId: string | null): string | null {
    const scmStatus = useSessionProjectScmStatus(paneId === 'git' ? sessionId : null, serverId);
    const mode = useSetting('tabBarGitBadgeMode');
    const workSummary = useSessionWorkSources()?.projection.summary;
    if (paneId === 'git') {
        const badge = resolveGitTabBadge(mode, scmStatus);
        if (!badge) return null;
        return badge.kind === 'count'
            ? t('widgetGlances.changedCount', { count: badge.value })
            : `+${badge.added} −${badge.removed}`;
    }
    if (paneId === 'agents' && workSummary) {
        const { bucket, count } = readWorkSummaryPresentation(workSummary);
        if (count === 0) return null;
        if (bucket === 'needs_you') return t('sessionWork.strip.needsYou', { count });
        if (bucket === 'working') return t('sessionWork.strip.stillWorking', { count });
        return `${count} · ${t('status.offline')}`;
    }
    return null;
}

/**
 * Opens one of the Session's panes beside the chat through the pane scope (the rail's path). The one way
 * the Companion opens a pane: its link rows and its section rows (Changes, Agents, Local services) both use it.
 */
export function useOpenSessionCompanionPane(sessionId: string, serverId: string | null): (paneId: string) => void {
    const pane = useAppPaneScope(useDestinationPaneScopeId(createSessionPaneScopeId(sessionId, serverId)));
    const openRight = pane.openRight;
    const setRightTab = pane.setRightTab;
    return React.useCallback((paneId: string) => {
        openRight({ tabId: paneId });
        setRightTab(paneId);
    }, [openRight, setRightTab]);
}

/** The live pane link: opens the pane beside the chat through the pane scope (the rail's path). */
export function PaneLinkRow(props: Readonly<{
    paneId: string;
    sessionId: string;
    serverId: string | null;
    frameStyle: WidgetFrameStyle;
    menu?: React.ReactNode;
    measurementOnly: boolean;
    testID: string;
}>) {
    const fact = usePaneRailFact(props.paneId, props.sessionId, props.serverId);
    const tab = builtinPane(props.paneId);
    const openPane = useOpenSessionCompanionPane(props.sessionId, props.serverId);
    const paneId = props.paneId;
    const open = React.useCallback(() => { openPane(paneId); }, [openPane, paneId]);
    return (
        <PaneLinkRowView
            testID={props.testID}
            label={sessionCompanionPaneLabel(props.paneId)}
            icon={tab?.icon ?? 'puzzle-piece'}
            fact={fact}
            frameStyle={props.frameStyle}
            menu={props.menu}
            {...(props.measurementOnly ? {} : { onOpen: open })}
        />
    );
}

