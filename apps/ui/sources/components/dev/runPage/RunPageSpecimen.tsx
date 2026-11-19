import * as React from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ReviewFindingsMessageCard } from '@/components/sessions/reviews/messages/ReviewFindingsMessageCard';
import { ExecutionRunContextChip } from '@/components/sessions/runs/ExecutionRunContextChip';
import { ExecutionRunStepsRow } from '@/components/sessions/runs/details/ExecutionRunStepsRow';
import { ExecutionRunStopFailedState } from '@/components/sessions/runs/details/ExecutionRunStopFailedState';
import { SessionExecutionRunInfoCard } from '@/components/sessions/runs/details/SessionExecutionRunInfoCard';
import { ExecutionRunChildChoiceCard } from '@/components/sessions/runs/launcher/ExecutionRunChildChoiceCard';
import { ExecutionRunLauncherOptions } from '@/components/sessions/runs/launcher/ExecutionRunLauncherOptions';
import type { ExecutionRunLauncherProfileChoice } from '@/components/sessions/runs/launcher/resolveExecutionRunLauncherProfileChoices';
import { GitCleanState } from '@/components/sessions/panes/git/GitCleanState';
import { projectExecutionRunChildChoiceV1 } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * Dev-only specimen of the Run page (agents lab RP1, MN, CV, ST, LN options), rendered through the
 * real owners with fixture data so the lab can be compared side by side without a signed-in Home.
 * Fixture copy is the lab's illustration, not product copy; no RPC is issued unless a control is
 * pressed.
 */
const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface.inset },
    content: { padding: theme.space.s24, gap: theme.space.s24, alignItems: 'flex-start' },
    contentPhone: { padding: 0 },
    column: {
        height: 900,
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s16,
        gap: theme.space.s12,
        backgroundColor: theme.colors.surface.base,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    columnPhone: { borderRadius: 0, borderWidth: 0, height: 844 },
    // The launcher's question inset (SessionInteractiveExecutionRunDraftView `question`).
    question: { paddingHorizontal: theme.space.s8 },
    caption: {  ...Typography.variant('body', 'semiBold'), color: theme.colors.text.secondary },
    states: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s24 },
    stateFrame: {
        width: 560,
        height: 460,
        backgroundColor: theme.colors.surface.base,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
}));

const noop = () => {};
const NOW = Date.now();

/** Two review profiles, one unavailable: the launcher offers them as one segmented choice beside Permissions. */
const PROFILE_DEFAULTS = { retention: 'resumable', runClass: 'bounded', io: 'streaming' } as const;
const PROFILE_CUSTODY = { kind: 'managed', immutableGenerationId: 'g1', installSource: 'archive' } as const;
const LAUNCHER_PROFILES: readonly ExecutionRunLauncherProfileChoice[] = [
    { id: 'review.coderabbit/review', intent: 'review', title: 'CodeRabbit', compatibleAgentIds: ['coderabbit'], compatibleAgentId: 'coderabbit', sourceCustody: PROFILE_CUSTODY, available: true, disabled: false, defaults: PROFILE_DEFAULTS },
    { id: 'review.deepsec/audit', intent: 'review', title: 'DeepSec Audit', compatibleAgentIds: ['deepsec'], compatibleAgentId: null, sourceCustody: PROFILE_CUSTODY, available: false, unavailableCode: 'missing_tool', disabled: true, defaults: PROFILE_DEFAULTS },
];

const reviewRun = {
    runId: 'run_7f3a91c2',
    callId: 'call_1',
    sidechainId: 'call_1',
    intent: 'review',
    display: { title: 'Review #2481 changes' },
    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    requestedConfiguration: { modelId: 'Opus 5.5' },
    permissionMode: 'read-only',
    retentionPolicy: 'resumable',
    runClass: 'bounded',
    ioMode: 'request_response',
    status: 'succeeded',
    startedAtMs: NOW - 400_000,
    finishedAtMs: NOW,
} as const;

const conversationRun = {
    runId: 'run_c0nv',
    callId: 'call_2',
    sidechainId: 'call_2',
    intent: 'delegate',
    display: { title: 'Why does the sheet remount on rotate?' },
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    requestedConfiguration: { modelId: 'GPT-6' },
    permissionMode: 'default',
    retentionPolicy: 'resumable',
    runClass: 'long_lived',
    ioMode: 'streaming',
    status: 'running',
    startedAtMs: NOW - 360_000,
    launchOrigin: { kind: 'discussion', serverId: 'server-a', discussionId: 'd1', messageIds: ['m1'] },
} as const;

const reviewPayload = {
    runRef: { runId: 'run_7f3a91c2', callId: 'call_1', backendId: 'claude', retentionPolicy: 'resumable' },
    summary: 'The fix is right for desktop; one path is still broken.',
    overviewMarkdown: 'The fix is right for desktop: keying by route keeps scroll and the draft through a resize. **One path is still broken**: the phone sheet has its own width key. Two smaller issues below.',
    findings: [
        { id: 'f3', title: 'The resize test only covers one width', severity: 'low', category: 'testing', summary: 'Add 390 and 1440 so the phone breakpoint is exercised.', filePath: 'settings/SettingsModal.test.tsx', startLine: 88 },
        { id: 'f1', title: 'The phone sheet is still keyed by width', severity: 'high', category: 'correctness', summary: 'Rotating a phone remounts the sheet and drops the draft, the same bug on the other platform.', filePath: 'settings/SettingsSheet.native.tsx', startLine: 41 },
        { id: 'f2', title: 'Route key ignores the query string', severity: 'medium', category: 'correctness', summary: '/settings?tab=keys and ?tab=voice share a key, so switching tabs keeps stale scroll.', filePath: 'settings/useSettingsRouteKey.ts', startLine: 12 },
    ],
    questions: [{ id: 'q1', text: 'Should tablets in split view keep a width key on purpose?', status: 'open' }],
    assumptions: [],
    triage: { findings: [{ id: 'f1', status: 'accept' }, { id: 'f2', status: 'defer' }, { id: 'f3', status: 'reject' }] },
    generatedAtMs: NOW,
} as const;

function RunColumn(props: Readonly<{ phone: boolean; children: React.ReactNode }>) {
    const { width } = useWindowDimensions();
    return (
        <View style={[styles.column, props.phone ? styles.columnPhone : null, { width: props.phone ? width : 600 }]}>
            {props.children}
        </View>
    );
}

export function RunPageSpecimen(props: Readonly<{ frame: string | null }>) {
    const { width } = useWindowDimensions();
    const phone = width < 600;
    const frame = props.frame ?? 'RP1';
    const [showSteps, setShowSteps] = React.useState(false);

    return (
        <ScrollView testID="run-page-specimen" style={styles.root} contentContainerStyle={[styles.content, phone ? styles.contentPhone : null]}>
            {frame === 'RP1' ? (
                <RunColumn phone={phone}>
                    <SessionExecutionRunInfoCard
                        run={reviewRun as never}
                        hostSessionId="dev-specimen"
                        copyResultText={reviewPayload.summary}
                        onShowInTranscript={noop}
                    />
                    <View style={{ flex: 1, minHeight: 0 }}>
                        <ReviewFindingsMessageCard
                            payload={reviewPayload as never}
                            sessionId="dev-specimen"
                            canSendMessages
                            presentation="page"
                            after={<ExecutionRunStepsRow expanded={showSteps} stepCount={14} onToggle={() => setShowSteps((v) => !v)} />}
                        />
                    </View>
                </RunColumn>
            ) : null}
            {frame === 'CV' ? (
                <RunColumn phone={phone}>
                    <SessionExecutionRunInfoCard
                        run={conversationRun as never}
                        hostSessionId="dev-specimen"
                        originTitle="Relay retry plan"
                        stopAction={{ stopping: false, onStop: noop }}
                    />
                    <ExecutionRunContextChip title="Relay retry plan" messageCount={1} />
                    <Text style={styles.caption}>{'(the exchange, the question and the composer are the canonical transcript and composer)'}</Text>
                </RunColumn>
            ) : null}
            {frame === 'ST' ? (
                <SurfaceStateSizeProvider size="details">
                    <View style={styles.states}>
                        <View style={styles.stateFrame}>
                            <SurfaceStateCard
                                testID="run-specimen-opening"
                                kind="loading"
                                title={t('surfaceState.opening', { name: 'Review the settings modal fix' })}
                                reason={t('runPage.opening.reading', { machine: 'MacBook Pro' })}
                            />
                        </View>
                        <View style={styles.stateFrame}>
                            <ExecutionRunStopFailedState
                                sessionId="dev-specimen"
                                serverId={null}
                                intent="review"
                                machineId="m1"
                                machineName="MacBook Pro"
                                diagnostic="rpc_timeout"
                                onRetry={noop}
                                onSessionStopped={noop}
                            />
                        </View>
                        <View style={styles.stateFrame}>
                            <SurfaceStateCard
                                kind="unavailable"
                                iconName="robot"
                                title={t('runPage.gone.title', { machine: 'MacBook Pro' })}
                                reason={t('runPage.gone.reason')}
                                action={{ label: t('runPage.gone.closeTab'), onPress: noop }}
                                secondaryAction={{ label: t('surfaceState.checkAgain'), onPress: noop }}
                                diagnosticCode="execution_run_not_found"
                            />
                        </View>
                    </View>
                </SurfaceStateSizeProvider>
            ) : null}
            {frame === 'IN' ? (
                <RunColumn phone={phone}>
                    <View style={styles.question}>
                        <ExecutionRunChildChoiceCard
                            choice={projectExecutionRunChildChoiceV1({ agentTargetKey: 'agent:codex' })}
                            agentTitle="Codex"
                            parentDetail="Claude subscription · Haiku 5.5"
                            starting={false}
                            onUseDefault={noop}
                            onChooseModel={noop}
                            onCancel={noop}
                        />
                    </View>
                    <GitCleanState
                        branch="relay-retry"
                        upstream="origin/relay-retry"
                        ahead={0}
                        behind={0}
                        lastCommitAt={NOW - 3_600_000}
                        lastPushedAt={NOW - 1_800_000}
                        phone={phone}
                        onCreatePullRequest={noop}
                        onOpenPullRequest={null}
                        pullRequestNumber={null}
                    />
                </RunColumn>
            ) : null}
            {frame === 'LN' ? (
                <RunColumn phone={phone}>
                    <ExecutionRunLauncherOptions
                        profileChoices={LAUNCHER_PROFILES}
                        selectedProfileId={LAUNCHER_PROFILES[0]!.id}
                        selectedPermissionMode="read-only"
                        permissionModeOptions={[{ value: 'read-only', label: 'Read-only' }, { value: 'default', label: 'Default' }] as never}
                        fields={[]}
                        input={{}}
                        editable
                        resolveFieldOptions={() => []}
                        onSelectProfile={noop}
                        onPatch={noop}
                    />
                </RunColumn>
            ) : null}
        </ScrollView>
    );
}
