import * as React from 'react';

import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import type { SessionBotFaceFacts } from '@/components/sessions/bots/face/sessionBotFaceFacts';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import type { SessionWorkStateSnapshot } from '@/sync/domains/session/workState/sessionWorkStateTypes';
import { t } from '@/text';

import { SessionManagedWorkflowSection } from './SessionManagedWorkflowSection';
import { SessionWorkflowActivitySection } from './SessionWorkflowActivitySection';
import type { SessionManagedWorkflowRunsState } from '@/components/workflows/run/useContextManagedWorkflowRuns';
import type { GoalActionCapabilities } from './goalActionVisibility';
import type { SessionWorkflowActivityState } from './useSessionWorkflowActivity';
import {
    useSessionWorkStateGoalController,
    type SessionWorkStateGoalOperationResult,
    type SessionWorkStateGoalSetRequest,
} from './useSessionWorkStateGoalController';

/**
 * The above-AgentInput work-state badge popover. A thin wrapper over the shared
 * `useSessionWorkStateGoalController` hook, adding the popover surface. The dirty-close guard and
 * goal read/edit logic live in the controller (D4) — this wrapper no longer owns a duplicate
 * `dirtyRef`; the AgentInput goal chip reuses the SAME controller, so both entry points stay in
 * lockstep.
 */
export function SessionWorkStatePopover(props: Readonly<{
    open: boolean;
    anchorRef: React.RefObject<any>;
    snapshot: SessionWorkStateSnapshot | null;
    bot?: Readonly<{
        name: string;
        purpose?: string;
        face?: SessionBotFaceFacts;
        paused: boolean;
        onTogglePause?: () => void;
        onOpenWork: () => void;
    }>;
    // UIW3: live workflow activity (headline + loaded run detail). The popover renders the Active
    // Workflows section from this; omit for goal-only surfaces (e.g. the AgentInput goal chip).
    workflowActivity?: SessionWorkflowActivityState;
    /**
     * Managed Workflow Runs this Session started. They are a different contract
     * from observed native activity above, so they render as their own section
     * rather than being merged into it.
     */
    managedWorkflowRuns?: SessionManagedWorkflowRunsState;
    onOpenManagedWorkflowRun?: (runId: string) => void;
    editableGoal?: boolean;
    /** The badge already names the goal's state (its presentation's `namesGoalStatus`). */
    anchorNamesGoalStatus?: boolean;
    // Provider goal-action profile for the "Set goal" form (no goal item yet) so the Codex-only
    // budget editor stays hidden on providers that don't support it (e.g. Claude). QA-CHIP-2.
    goalActionCapabilityProfile?: GoalActionCapabilities | null;
    onRequestClose: () => void;
    onSetGoal?: (request: SessionWorkStateGoalSetRequest, signal?: AbortSignal) => Promise<SessionWorkStateGoalOperationResult>;
    onClearGoal?: (signal?: AbortSignal) => Promise<SessionWorkStateGoalOperationResult>;
}>) {
    const managedWorkflowSection = props.managedWorkflowRuns !== undefined
        && props.onOpenManagedWorkflowRun !== undefined
        ? (
            <SessionManagedWorkflowSection
                state={props.managedWorkflowRuns}
                onOpenRun={props.onOpenManagedWorkflowRun}
            />
        )
        : null;
    const workflowSection = props.workflowActivity || managedWorkflowSection ? (
        <>
            {props.workflowActivity
                ? <SessionWorkflowActivitySection activity={props.workflowActivity} />
                : null}
            {managedWorkflowSection}
        </>
    ) : null;
    const { content, guardedRequestClose } = useSessionWorkStateGoalController({
        open: props.open,
        snapshot: props.snapshot,
        editableGoal: props.editableGoal === true,
        goalActionCapabilityProfile: props.goalActionCapabilityProfile ?? null,
        workflowSection,
        showEmptyGoalControls: false,
        goalStatusShownByAnchor: props.anchorNamesGoalStatus === true,
        onRequestClose: props.onRequestClose,
        onSetGoal: props.onSetGoal,
        onClearGoal: props.onClearGoal,
    });

    const bot = props.bot;
    return (
        <AgentInputContentPopover
            open={props.open}
            anchorRef={props.anchorRef}
            onRequestClose={guardedRequestClose}
            maxWidthCap={420}
            maxHeightCap={520}
            testID="session-work-state-popover-surface"
            // The Bot's own row leads the popover (lab session-orchestration S2); the popover title only names it.
            header={bot ? { title: bot.name, placement: 'label' } : undefined}
            content={() => <>
                {bot ? <SessionWorkStateBotHeader bot={bot} /> : null}
                {content}
            </>}
        />
    );
}

type SessionWorkStateBot = NonNullable<React.ComponentProps<typeof SessionWorkStatePopover>['bot']>;

/**
 * Who this work belongs to, as one row (lab S2, owner R6: no separate Bot card): the face, the name with Pause or
 * Resume and Open Work › on its line, and the purpose beneath. Needs you, Running, Workflows and Next follow.
 */
function SessionWorkStateBotHeader(props: Readonly<{ bot: SessionWorkStateBot }>) {
    const { bot } = props;
    return (
        <View testID="session-work-state-bot-header" style={styles.botHeader}>
            {bot.face ? <SessionBotFace facts={bot.face} size={BOT_HEADER_FACE_PX} motion={false} /> : null}
            <View style={styles.botHeaderText}>
                <View style={styles.botHeaderTitleRow}>
                    <Text variant="label" emphasis="semiBold" numberOfLines={1} style={styles.botHeaderName}>{bot.name}</Text>
                    {bot.onTogglePause ? (
                        <RoundButton
                            testID="session-work-state-bot-toggle-pause"
                            size="small"
                            display="secondary"
                            title={t(bot.paused ? 'sessionWork.botControls.resume' : 'sessionWork.botControls.pause')}
                            onPress={bot.onTogglePause}
                        />
                    ) : null}
                    <TextLinkButton
                        testID="session-work-state-bot-open-work"
                        size="meta"
                        label={t('sessionWork.botControls.openWork')}
                        onPress={bot.onOpenWork}
                    />
                </View>
                {bot.purpose ? (
                    <Text variant="meta" numberOfLines={2} style={styles.botHeaderPurpose}>{bot.purpose}</Text>
                ) : null}
            </View>
        </View>
    );
}

/** The identity size every Bot header uses (lab S2 and the hover card). */
const BOT_HEADER_FACE_PX = 32;

const styles = StyleSheet.create((theme) => ({
    botHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s12,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
    },
    botHeaderText: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s4,
    },
    botHeaderTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    botHeaderName: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.primary,
    },
    botHeaderPurpose: {
        color: theme.colors.text.secondary,
    },
}));
