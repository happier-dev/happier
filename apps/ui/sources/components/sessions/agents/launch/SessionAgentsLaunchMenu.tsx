import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useOpenAppSection } from '@/components/appShell/workspace/destinationRoute';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ExecutionRunIntent } from '@/components/sessions/runs/launcher/executionRunLauncherModel';
import { WorkflowStartPicker } from '@/components/workflows/run/WorkflowStartPicker';
import { t } from '@/text';
import type { SessionAgentLauncher } from './useSessionAgentLauncher';

const INTENT_COPY = {
    review: { icon: 'shield-check', title: 'executionRuns.newRun.intents.review', subtitle: 'sessionAgentActivity.roster.launch.reviewDescription' },
    plan: { icon: 'list-checks', title: 'executionRuns.newRun.intents.plan', subtitle: 'sessionAgentActivity.roster.launch.planDescription' },
    delegate: { icon: 'arrow-elbow-down-right', title: 'executionRuns.newRun.intents.delegate', subtitle: 'sessionAgentActivity.roster.launch.delegateDescription' },
} as const satisfies Record<ExecutionRunIntent, { icon: IconName; title: string; subtitle: string }>;

const ALL_WORKFLOWS_ITEM_ID = 'workflow-all';
/** Second opinion is ORC's role on a review start (INT §6 I4); no new run intent. */
const SECOND_OPINION_ROLE_ID = 'second_opinion';

/**
 * The Work tab's "+" (lab `convo-W1`/`W4`, phone `P2`): everything that can start from here, in one
 * menu. A new agent conversation; the asks this Session's backends take (Review · Plan · Delegate,
 * and Second opinion: a review run by ORC's `second_opinion` role), each opening the composer-first
 * start; the shared workflow chooser, opening the selected reference in Start; a trigger in this
 * Session's Triggers section; the Agent's own launcher (a Claude team) when it contributes one; and
 * Advanced (several agents, permissions, profile). When agents cannot start here those rows are not
 * drawn; the pane says why instead.
 */
export const SessionAgentsLaunchMenu = React.memo((props: Readonly<{
    launcher: SessionAgentLauncher;
    /** Opens this Session's Triggers section; absent while that section is not mounted here. */
    onAddTrigger?: (() => void) | null;
    /** Opens this Session's Goal control (FIN 04's one entry); absent where the session can't hold a goal. */
    onKeepGoing?: (() => void) | null;
    /** Why agents cannot start here ("Starting agents needs ubuntu-02 online"), said once in the menu. */
    unavailableText?: string | null;
    testID?: string;
}>) => {
    const { theme } = useUnistyles();
    const openSection = useOpenAppSection();
    const [open, setOpen] = React.useState(false);
    const [choosingWorkflow, setChoosingWorkflow] = React.useState(false);
    const changeOpen = React.useCallback((next: boolean) => {
        setOpen(next);
        if (!next) setChoosingWorkflow(false);
    }, []);
    const { launcher, onAddTrigger, onKeepGoing } = props;
    const canRun = launcher.unavailableReason === null;
    const iconColor = theme.colors.text.secondary;
    const items = React.useMemo((): readonly DropdownMenuItem[] => {
        const result: DropdownMenuItem[] = [];
        const askSection = t('agentStart.menu.askSection');
        if (canRun) {
            result.push({
                id: 'conversation',
                testID: 'session-agents-launch:conversation',
                title: t('session.subagents.panel.newAgentConversation'),
                subtitle: t('sessionAgentActivity.roster.launch.conversationDescription'),
                icon: <Icon name="chat-circle" size={16} color={iconColor} />,
            });
            for (const intent of launcher.intents) {
                const copy = INTENT_COPY[intent];
                result.push({
                    id: intent,
                    testID: `session-agents-launch:${intent}`,
                    category: askSection,
                    title: t(copy.title),
                    subtitle: t(copy.subtitle),
                    icon: <Icon name={copy.icon} size={16} color={iconColor} />,
                });
            }
            if (launcher.intents.includes('review')) {
                result.push({
                    id: 'second-opinion',
                    testID: 'session-agents-launch:second-opinion',
                    category: askSection,
                    title: t('agentStart.menu.secondOpinionTitle'),
                    subtitle: t('agentStart.menu.secondOpinionSubtitle'),
                    icon: <Icon name="checks" size={16} color={iconColor} />,
                });
            }
            if (onKeepGoing) {
                // Lab `convo-W1`: the Goal control attaches the built-in; the menu only opens it.
                result.push({
                    id: 'keep-going',
                    testID: 'session-agents-launch:keep-going',
                    category: askSection,
                    title: t('agentStart.menu.keepGoingTitle'),
                    subtitle: t('agentStart.menu.keepGoingSubtitle'),
                    icon: <Icon name="target" size={16} color={iconColor} />,
                });
            }
        }
        result.push({
            id: 'run-workflow',
            testID: 'session-agents-launch:run-workflow',
            title: t('agentStart.menu.runWorkflowTitle'),
            subtitle: t('agentStart.menu.runWorkflowSubtitle'),
            icon: <Icon name="tree-structure" size={16} color={iconColor} />,
            keepMenuOpen: true,
        });
        if (onAddTrigger) {
            result.push({
                id: 'add-trigger',
                testID: 'session-agents-launch:add-trigger',
                title: t('agentStart.menu.addTriggerTitle'),
                subtitle: t('agentStart.menu.addTriggerSubtitle'),
                icon: <Icon name="lightning" size={16} color={iconColor} />,
            });
        }
        if (launcher.providerLaunch) {
            result.push({
                id: 'provider',
                testID: 'session-agents-launch:provider',
                title: launcher.providerLaunch.title,
                ...(launcher.providerLaunch.subtitle ? { subtitle: launcher.providerLaunch.subtitle } : {}),
                icon: <Icon name="users" size={16} color={iconColor} />,
            });
        }
        if (canRun) {
            result.push({
                id: 'advanced',
                testID: 'session-agents-launch:advanced',
                title: t('agentStart.menu.advancedTitle'),
                subtitle: t('agentStart.menu.advancedSubtitle'),
                icon: <Icon name="sliders-horizontal" size={16} color={iconColor} />,
            });
        }
        return result;
    }, [canRun, iconColor, launcher.intents, launcher.providerLaunch, onAddTrigger, onKeepGoing]);

    const select = React.useCallback((itemId: string) => {
        if (itemId === 'run-workflow') {
            setChoosingWorkflow(true);
            return;
        }
        changeOpen(false);
        if (itemId === 'conversation') launcher.openConversation();
        else if (itemId === 'advanced') launcher.openRun();
        else if (itemId === 'provider') launcher.providerLaunch?.open();
        else if (itemId === 'add-trigger') onAddTrigger?.();
        else if (itemId === 'keep-going') onKeepGoing?.();
        else if (itemId === 'second-opinion') {
            launcher.openRun('review', { roleId: SECOND_OPINION_ROLE_ID, title: t('agentStart.menu.secondOpinionTitle') });
        }
        // The rest of the library lives in the Workflows destination.
        else if (itemId === ALL_WORKFLOWS_ITEM_ID) openSection('/workflows');
        else if (itemId === 'review' || itemId === 'plan' || itemId === 'delegate') launcher.openRun(itemId);
    }, [changeOpen, launcher, onAddTrigger, onKeepGoing, openSection]);

    // The starts that cannot run are not drawn; one quiet note above what can still be done says why,
    // whole: it is a sentence, not a choice, so it never truncates like a row title.
    const unavailableNote = !canRun && props.unavailableText ? (
        <View style={styles.note}>
            <Icon name="lock" size={14} color={theme.colors.text.secondary} />
            <Text testID="session-agents-launch:unavailable" style={styles.noteText}>{props.unavailableText}</Text>
        </View>
    ) : undefined;

    if (items.length === 0) return null;

    return (
        <>
        <DropdownMenu
            testID={props.testID ?? 'session-agents-launch-menu'}
            open={open}
            onOpenChange={changeOpen}
            header={choosingWorkflow ? <RoundButton testID="session-agents-launch:workflow-back" size="small"
                display="inverted" title={t('common.back')} onPress={() => setChoosingWorkflow(false)} /> : unavailableNote}
            items={choosingWorkflow ? [] : items}
            emptyLabel={null}
            footer={choosingWorkflow ? <RoundButton testID="session-agents-launch:workflow-all" size="small" display="inverted" title={t('agentStart.menu.allWorkflows')}
                onPress={() => select(ALL_WORKFLOWS_ITEM_ID)} /> : undefined}
            renderContent={open && choosingWorkflow ? ({ maxHeight, requestClose }) => <WorkflowStartPicker hasOriginSession
                maxHeight={maxHeight} onSelectReference={launcher.startWorkflow}
                onRequestClose={() => requestClose('selection')} /> : undefined}
            onSelect={select}
            matchTriggerWidth={false}
            showCategoryTitles
            placement="bottom"
            // Lab P2: on a phone the menu is the shared bottom sheet, as the composer pickers are.
            popoverPhonePresentation="sheet"
            popoverAccessibilityLabel={t('sessionAgentActivity.roster.launch.menuA11y')}
            trigger={({ open: isOpen, toggle }) => (
                <IconButton
                    testID="session-agents-launch-button"
                    iconName="plus"
                    variant="plain"
                    selected={isOpen}
                    accessibilityLabel={t('sessionAgentActivity.roster.launch.menuA11y')}
                    tooltip={t('sessionAgentActivity.roster.launch.menuA11y')}
                    onPress={toggle}
                />
            )}
        />
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    // On the rows' text edge; secondary and a step smaller than a row title, so it reads as a note.
    note: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s8,
        paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
        paddingTop: theme.space.s10,
        paddingBottom: theme.space.s6,
    },
    noteText: {
        flex: 1,
        minWidth: 0,
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
}));
