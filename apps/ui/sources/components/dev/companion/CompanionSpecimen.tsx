import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SessionCompanionItemFrame } from '@/components/sessions/companion/SessionCompanionItemFrame';
import { SessionAgentPlanCard, type SessionAgentPlanActivity } from '@/components/sessions/companion/plan/SessionAgentPlanCard';
import { projectSessionAgentPlan } from '@/components/sessions/companion/plan/sessionAgentPlan';
import { SessionCompanionAddControl } from '@/components/sessions/companion/picker/SessionCompanionAddControl';
import { CompanionWidgetAddPopover } from '@/components/widgets/add/CompanionWidgetAddPopover';
import { SessionSummaryCard } from '@/components/sessions/companion/summary/SessionSummaryCard';
import type { SessionSummaryCardModel } from '@/components/sessions/companion/summary/sessionSummaryProjection';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { createSessionSurfaceNoteDocumentV1, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';

import { projectSessionBoard } from '@/sync/domains/session/board';
import type { SessionPendingPermission } from '@/sync/ops/sessionPendingPermissions';
import { t } from '@/text';

/**
 * Dev-only fixtures for the Companion column (lab `companion`, frames CA/CX/CP/CS): the real
 * Summary hero, Plan item, item frames and Add to Companion picker on the lab's session, so the
 * build can be paired against the lab without a live session on the dev account.
 */

const ASK: SessionPendingPermission = {
    requestId: 'specimen-ask',
    toolName: 'Bash',
    summary: 'Run yarn test:ui',
    command: 'The full UI suite on MacBook Pro · about 4 min',
    createdAtMs: Date.now() - 134_000,
    policy: { protocol: 'standard', usePermissionUpdates: false },
    answers: ['allowOnce', 'allowForSession', 'deny'],
};

const PLAN = projectSessionAgentPlan([
    { id: 'p1', content: 'Find why the modal remounts', status: 'completed', priority: 'medium' },
    { id: 'p2', content: 'Key the modal by route', status: 'completed', priority: 'medium' },
    { id: 'p3', content: 'Add a resize test at 3 widths', status: 'completed', priority: 'medium' },
    { id: 'p4', content: 'Run the full UI suite', status: 'in_progress', priority: 'medium' },
    { id: 'p5', content: 'Push and open the PR', status: 'pending', priority: 'medium' },
]);

function model(overrides: Partial<SessionSummaryCardModel> = {}): SessionSummaryCardModel {
    return {
        scope: 'exact',
        title: 'Fix settings modal remount',
        agentLabel: 'Claude',
        agentId: 'claude',
        status: { state: 'permission_required', statusText: 'Permission required', quiet: false },
        stale: false,
        availability: 'complete',
        encryption: 'plain',
        identityDestination: 'sessionInfo',
        rows: [],
        needsYou: { request: ASK, moreCount: 0 },
        sinceMs: ASK.createdAtMs ?? null,
        progress: { step: 4, total: 5 },
        plan: PLAN,
        facts: [
            { kind: 'subagents', live: 2, total: 3, destination: 'workTab' },
            { kind: 'changes', count: 14, destination: 'git' },
            { kind: 'context', percent: 62, stale: false, destination: 'usage' },
        ],
        ...overrides,
    };
}

const NOOP = (): void => {};
const DESTINATIONS = { workTab: NOOP, git: NOOP, usage: NOOP, approvals: NOOP };
const ITEM_ACTIONS = [
    { id: 'move-down', title: t('common.moveDown'), icon: 'arrow-down' as const, onPress: NOOP },
    { id: 'remove', title: t('sessionBoard.companion.actions.removeFromCompanion'), icon: 'x' as const, onPress: NOOP },
];

function boardItem(title: string, source: SessionSurfaceItemV1['source']) {
    const value: SessionSurfaceItemV1 = { v: 1, title, frame: 'card', height: { mode: 'auto', fallback: 'regular' }, source };
    return { revision: 'r1', outcome: { status: 'ready' as const, value } };
}

const BOARD = projectSessionBoard({
    layout: undefined,
    items: new Map([
        ['note', boardItem('Open question', { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1('Does the phone sheet need the same key?') })],
        ['relay', boardItem('Relay retries, last 90 min', { kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<main></main>'), requestedCapabilities: {} })],
        ['conv', boardItem('External conversations', { kind: 'widget', instance: { v: 1, id: 'conv',
            definition: { kind: 'installed', surface: { pluginId: 'happier.channels', localId: 'conversations' } }, bindings: {} } })],
    ]),
    capabilities: { readTranscript: true, editSessionRecords: true },
    freshness: 'fresh',
    reachability: 'reachable',
    loading: 'idle',
    incomplete: false,
});

const REFS = [
    { kind: 'builtin' as const, id: 'session_summary' as const },
    { kind: 'builtin' as const, id: 'agent_plan' as const },
    { kind: 'widget' as const, widgetId: 'relay' },
    { kind: 'widget' as const, widgetId: 'conv' },
];

const stylesheet = StyleSheet.create((theme) => ({
    page: { flex: 1, backgroundColor: theme.colors.surface.inset },
    pageContent: { padding: 24, gap: 24, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start' },
    frame: { gap: 8 },
    caption: { ...Typography.default('semiBold'), fontSize: 12, color: theme.colors.text.tertiary },
    rail: {
        width: 390,
        minHeight: 720,
        backgroundColor: theme.colors.surface.base,
        borderStartWidth: 1,
        borderStartColor: theme.colors.border.default,
    },
    phone: { width: 390, minHeight: 760, backgroundColor: theme.colors.surface.base },
    railHeader: { paddingStart: 12, paddingTop: 10, paddingBottom: 2 },
    railTitle: { ...Typography.default('semiBold'), fontSize: 15, color: theme.colors.text.primary },
    column: { paddingHorizontal: 12, paddingBottom: 12 },
}));

function PlanItem(props: Readonly<{ activity: SessionAgentPlanActivity }>) {
    return (
        <SessionCompanionItemFrame label="Plan" actions={ITEM_ACTIONS} separated testID="specimen-plan">
            {(accessory) => (
                <SessionAgentPlanCard plan={PLAN} agentLabel="Claude" activity={props.activity} headerAccessory={accessory} testID="specimen-plan-card" />
            )}
        </SessionCompanionItemFrame>
    );
}

function Column(props: Readonly<{ summary: SessionSummaryCardModel; activity: SessionAgentPlanActivity; phone?: boolean; add?: boolean }>) {
    const styles = stylesheet;
    return (
        <View style={props.phone ? styles.phone : styles.rail}>
            {props.phone ? null : (
                <View style={styles.railHeader}>
                    <Text style={styles.railTitle}>{t('sessionBoard.companion.title')}</Text>
                </View>
            )}
            <View style={styles.column}>
                <SessionCompanionItemFrame label="Session summary" actions={ITEM_ACTIONS} testID="specimen-summary">
                    {(accessory) => (
                        <SessionSummaryCard
                            model={props.summary}
                            density="comfortable"
                            destinations={DESTINATIONS}
                            answerPermission={async () => {}}
                            showPermissionInChat={NOOP}
                            machineName="MacBook Pro"
                            headerAccessory={accessory}
                            presentation="full"
                            testID="specimen-summary-card"
                        />
                    )}
                </SessionCompanionItemFrame>
                <PlanItem activity={props.activity} />
                {props.add === false ? null : (
                    <SessionCompanionAddControl
                        binding={{ refs: REFS, snapshot: BOARD, pluginProjection: null, addItem: NOOP }}
                        variant="row"
                        testID="specimen-add"
                    />
                )}
            </View>
        </View>
    );
}

function PickerFrame() {
    const anchorRef = React.useRef<View | null>(null);
    const [open, setOpen] = React.useState(false);
    // Open after layout so the popover anchors to the measured row, as a click would.
    React.useEffect(() => {
        const id = setTimeout(() => setOpen(true), 300);
        return () => clearTimeout(id);
    }, []);
    return (
        <View style={stylesheet.rail}>
            <View style={{ flex: 1 }} />
            <View ref={anchorRef} style={{ height: 34, marginHorizontal: 12, marginBottom: 12 }} />
            <CompanionWidgetAddPopover
                open={open}
                anchorRef={anchorRef}
                placement="top"
                source={{ refs: REFS, snapshot: BOARD, pluginProjection: null, addItem: NOOP }}
                onRequestClose={NOOP}
                testID="specimen-picker"
            />
        </View>
    );
}

function StatesFrame() {
    return (
        <View style={[stylesheet.rail, { padding: 12, gap: 16 }]}>
            <SurfaceStateSizeProvider size="pane">
                <SurfaceStateCard
                    kind="empty"
                    title={t('sessionBoard.companion.empty.title')}
                    reason={t('sessionBoard.companion.empty.reason')}
                    note={t('sessionBoard.companion.empty.note')}
                    action={{ label: t('sessionBoard.companion.actions.addSummary'), onPress: NOOP }}
                    secondaryAction={{ label: t('sessionCompanion.picker.chooseWidget'), onPress: NOOP }}
                />
            </SurfaceStateSizeProvider>
            <SessionSummaryCard
                model={model({
                    stale: true,
                    status: { state: 'disconnected', statusText: 'Disconnected', quiet: false },
                    needsYou: { request: { ...ASK, answers: [] }, moreCount: 0 },
                })}
                density="comfortable"
                machineName="MacBook Pro"
                presentation="full"
                testID="specimen-offline"
            />
            <SurfaceStateCard
                size="line"
                kind="unavailable"
                title={t('sessionBoard.item.removed.title')}
                reason={t('sessionBoard.item.removed.reason')}
                action={{ label: t('sessionBoard.companion.actions.removeFromCompanion'), onPress: NOOP }}
            />
        </View>
    );
}

export function CompanionSpecimen(props: Readonly<{ only: string | null; phone: boolean }>) {
    useUnistyles();
    const frames: Record<string, React.ReactNode> = {
        CA: <Column summary={model()} activity="held" phone={props.phone} />,
        CX: <Column summary={model({ needsYou: null, status: { state: 'thinking', statusText: 'Working', quiet: false }, sinceMs: Date.now() - 12_000 })} activity="working" phone={props.phone} />,
        CP: <PickerFrame />,
        CS: <StatesFrame />,
    };
    const ids = props.only ? [props.only] : Object.keys(frames);
    return (
        <ScrollView style={stylesheet.page} contentContainerStyle={stylesheet.pageContent}>
            {ids.map((id) => (
                <View key={id} style={stylesheet.frame} testID={`companion-specimen-${id}`}>
                    {props.only ? null : <Text style={stylesheet.caption}>{id}</Text>}
                    {frames[id] ?? null}
                </View>
            ))}
        </ScrollView>
    );
}
