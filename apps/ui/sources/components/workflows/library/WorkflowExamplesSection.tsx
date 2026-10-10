import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPageSheet } from '@happier-dev/plugin-ui/presentation';
import { WORKFLOW_STARTER_EXAMPLES_V1, materializeWorkflowStarterExample, type WorkflowStarterExampleSelection, type WorkflowStarterSessionTarget, type WorkflowStarterExampleKeyV1, type WorkflowStarterExampleV1 } from '@happier-dev/protocol/workflows/builtins/examples';
import { countWorkflowStepsV1 } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemGroupColumn, ItemGroupColumns } from '@/components/ui/lists/ItemGroupColumns';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { getPreferredLanguage, t, tLoose } from '@/text';
import { en } from '@/text/translations/en';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { storeWorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';
import { useWorkflowExistingSessionOptions } from '../screens/useWorkflowExistingSessionOptions';
import { readDeviceTimeZone } from '../triggers/sessionTriggerForm';
import { WorkflowFlowView } from '../flow/WorkflowFlowView';
import { projectWorkflowFlow } from '../flow/workflowFlowProjection';

/**
 * Inside a Session the example is already bound to it, so a description that begins "Choose a session…"
 * would ask for a choice that is not there. These say what the example does *here*; the others read the
 * same in both places.
 */
const SESSION_DESCRIPTION_KEYS: Partial<Record<WorkflowStarterExampleKeyV1, 'workflows.examples.sessionNotifyDescription'
    | 'workflows.examples.sessionDailySummaryDescription' | 'workflows.examples.sessionTestDescription'>> = {
    'notify-when-agent-waits': 'workflows.examples.sessionNotifyDescription',
    'daily-summary-in-session': 'workflows.examples.sessionDailySummaryDescription',
    'test-after-every-turn': 'workflows.examples.sessionTestDescription',
};

/** The same read-only examples everywhere. Selection itself never writes or starts a Run. */
export function WorkflowExamplesSection(props: Readonly<{
    onUse?: (example: WorkflowStarterExampleSelection) => void;
    onDidUse?: () => void;
    /** Inline trigger selection is not a new editor draft. */
    opensDraft?: boolean;
    /**
     * Opened from a Session's Triggers "+" (lab `b-habit T`, 65s5): offer the full starter catalog
     * and supply the current Session to the existing materializer, with no chooser.
     */
    session?: WorkflowStarterSessionTarget;
    /** `list`: a Session's compact one-line-per-example picker (with `session`); `cards` draws each with its map. */
    presentation?: 'cards' | 'list';
}>): React.ReactElement {
    const router = useRouter();
    const [choice, setChoice] = React.useState<Readonly<{ key: string; lifetime: ActiveServerAccountScopeLifetime | null }> | null>(null);
    const useExample = (example: WorkflowStarterExampleSelection) => {
        if (props.onUse) props.onUse(example);
        else if (example.trigger !== undefined || example.sessionTarget !== undefined) {
            const definitionDraftSeedId = storeWorkflowDefinitionDraftSeed({ name: tLoose(example.titleKey),
                description: tLoose(example.descriptionKey), definition: example.definition,
                trigger: example.trigger, sessionTarget: example.sessionTarget });
            router.push({ pathname: '/workflows/new', params: { definitionDraftSeedId } } as never);
        } else router.push({ pathname: '/workflows/new', params: { example: example.key } } as never);
        props.onDidUse?.();
    };
    const session = props.session;
    const examples = props.opensDraft === false
        ? WORKFLOW_STARTER_EXAMPLES_V1.filter(example => example.triggerSeed === undefined) : WORKFLOW_STARTER_EXAMPLES_V1;
    const choose = (example: WorkflowStarterExampleV1) => {
        const selection = materializeWorkflowStarterExample(example,
            session !== undefined ? { session, timezone: readDeviceTimeZone() } : undefined);
        if (selection.status === 'ready') useExample(selection.example);
        // Only the library asks which Session: inside one, every example is already bound to it.
        else if (session === undefined) setChoice({ key: example.key, lifetime: captureActiveServerAccountScopeLifetime() });
    };
    if (session !== undefined && props.presentation === 'list') {
        // A Session's own picker (lab `b-habit T`): the full catalog, one line each, and never a Session chooser.
        return <ItemGroup title={t('workflows.examples.title')} description={t('workflows.examples.sessionDescription')}>
            {examples.map((example) => {
                const sessionDescriptionKey = SESSION_DESCRIPTION_KEYS[example.key];
                return <Item key={example.key} testID={`workflow-examples:${example.key}`}
                    title={tLoose(example.titleKey)} subtitle={sessionDescriptionKey ? t(sessionDescriptionKey) : tLoose(example.descriptionKey)} subtitleLines={0}
                    showChevron={false} mode="info"
                    rightElement={<RoundButton testID={`workflow-examples:${example.key}:use`} size="small" display="secondary"
                        title={t('workflows.examples.use')} accessibilityLabel={`${t('workflows.examples.use')}: ${tLoose(example.titleKey)}`}
                        onPress={() => choose(example)} />} />;
            })}
        </ItemGroup>;
    }
    return <ItemGroup title={t('workflows.examples.title')} surface="none"
        {...(props.opensDraft === false ? {} : { description: t('workflows.examples.description') })}>
        <SectionContentRow showDivider={false}>
            <ItemGroupColumns columns={2} paddingHorizontal={0} paddingVertical={0}>
                {examples.map((example) => <ItemGroupColumn key={example.key} style={styles.cell}>
                    <ExampleCard example={example} onUse={() => choose(example)} useControl={choice?.key === example.key ? <ExampleSessionChooser example={example} lifetime={choice.lifetime}
                        onClose={() => setChoice(null)} onUse={useExample} /> : undefined} />
                </ItemGroupColumn>)}
            </ItemGroupColumns>
        </SectionContentRow>
    </ItemGroup>;
}

/** Session subscriptions live only in the open chooser, not every catalog card. */
function ExampleSessionChooser(props: Readonly<{
    example: WorkflowStarterExampleV1;
    lifetime: ActiveServerAccountScopeLifetime | null;
    onClose: () => void;
    onUse: (example: WorkflowStarterExampleSelection) => void;
}>) {
    const scope = useActiveServerAccountScope();
    const { existingSessions } = useWorkflowExistingSessionOptions({ serverId: scope?.serverId ?? null, machineId: null });
    const sessions = scope === null || !props.lifetime?.isCurrent() ? [] : existingSessions;
    return <View style={styles.chooser}>
        <DropdownMenu open onOpenChange={(open) => { if (!open) props.onClose(); }} search
            items={sessions.map(session => ({ id: session.sessionId, title: session.label }))} selectedId={null}
            trigger={({ toggle }) => <RoundButton testID={`workflow-examples:${props.example.key}:use`} size="small" display="secondary"
                title={t('workflows.examples.chooseSession')}
                accessibilityLabel={`${t('workflows.examples.chooseSession')}: ${tLoose(props.example.titleKey)}`} onPress={toggle} />}
            onSelect={(sessionId) => {
                if (!props.lifetime?.isCurrent()) return;
                const session = sessions.find(candidate => candidate.sessionId === sessionId);
                if (!session) return;
                const selection = materializeWorkflowStarterExample(props.example, { session, timezone: readDeviceTimeZone() });
                if (selection.status !== 'ready') return;
                props.onClose();
                props.onUse(selection.example);
            }} />
        {sessions.length === 0 ? <Text style={styles.description}>{tLoose('workflows.examples.noSessions')}</Text> : null}
    </View>;
}

/**
 * One example (lab `nav-N3`): what it does, the thing itself as the small map under it, and a footer
 * with the one fact that sizes it and its bordered **Use this**.
 */
function ExampleCard(props: Readonly<{ example: WorkflowStarterExampleV1; onUse: () => void; useControl?: React.ReactNode }>) {
    const { example } = props;
    const { theme } = useUnistyles();
    const language = getPreferredLanguage();
    const projection = React.useMemo(() => projectWorkflowFlow(example.definition, {}, Object.fromEntries(
        Object.keys(en.workflows.examples.nodes).map(key => [key,
            t(`workflows.examples.nodes.${key as keyof typeof en.workflows.examples.nodes}`)]),
    )), [example.definition, language]);
    const stepCount = React.useMemo(
        () => countWorkflowStepsV1(example.definition.blocks),
        [example.definition],
    );
    const structure = projection.nodes.find(node => node.kind === 'parallel' || node.kind === 'loop' || node.kind === 'if');
    const shape = structure?.kind === 'parallel' ? t('workflows.editor.addParallel') : structure?.label;
    return <HappierPageSheet testID={`workflow-examples:${example.key}`} rowDividers={false} style={styles.sheet}
        colors={{ sheet: theme.colors.surface.base, sheetBorder: theme.colors.border.default,
            rowDivider: theme.colors.border.subtle, groupDivider: theme.colors.border.subtle }}><View style={styles.card}>
        <View style={styles.copy}>
            <Text style={styles.title}>{tLoose(example.titleKey)}</Text>
            <Text style={styles.description}>{tLoose(example.descriptionKey)}</Text>
        </View>
        <View testID={`workflow-examples:${example.key}:preview`} style={styles.preview}>
            {/* The one map at its small size (lab nav-N3 `uwMap(…, { sm: true })`): one-line labels on
                the card's own paper, so a short example leaves quiet space, not an empty well (DESIGN-7 P5). */}
            <WorkflowFlowView projection={projection} selectedNodeId={null} preview density="compact"
                testIDPrefix={`workflow-examples:${example.key}:flow`} />
        </View>
        <View style={styles.footer}>
            <Text style={styles.meta}>{[t('workflows.examples.stepCount', { count: stepCount }), shape].filter(Boolean).join(' · ')}</Text>
            {props.useControl ?? <RoundButton testID={`workflow-examples:${example.key}:use`} size="small" display="secondary"
                title={t('workflows.examples.use')} accessibilityLabel={`${t('workflows.examples.use')}: ${tLoose(example.titleKey)}`} onPress={props.onUse} />}
        </View>
    </View></HappierPageSheet>;
}

const styles = StyleSheet.create((theme) => ({
    // A row's cells share its height, and each card fills its cell, so cards side by side end together.
    cell: { flexGrow: 1 },
    // The map band runs edge to edge, so the sheet clips it to its own corners.
    sheet: { flexGrow: 1, minWidth: 0, overflow: 'hidden' },
    card: { flexGrow: 1, minWidth: 0 },
    copy: { gap: theme.margins.xs, padding: theme.margins.md },
    title: { ...Typography.default('semiBold'), color: theme.colors.text.primary },
    description: { ...Typography.default(), color: theme.colors.text.secondary },
    // The example itself, on the card's paper (lab nav-N3); the footer's hairline closes it. A short map
    // beside a taller neighbour sits in the middle of the paper it is given, not on top of an empty well
    // (DESIGN-9 P5 "Ask once").
    preview: {
        flexGrow: 1,
        justifyContent: 'center',
        paddingHorizontal: theme.margins.md,
        paddingBottom: theme.margins.md,
    },
    footer: {
        marginTop: 'auto',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.margins.sm,
        paddingHorizontal: theme.margins.md,
        paddingVertical: theme.margins.sm,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.subtle,
    },
    meta: { ...Typography.default(), flexShrink: 1, color: theme.colors.text.tertiary },
    chooser: { flexShrink: 1, minWidth: 0, alignItems: 'flex-end', gap: theme.margins.xs },
}));
