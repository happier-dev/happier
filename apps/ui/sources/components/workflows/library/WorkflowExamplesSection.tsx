import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPageSheet } from '@happier-dev/plugin-ui/presentation';
import { WORKFLOW_STARTER_EXAMPLES_V1, type WorkflowStarterExampleV1 } from '@happier-dev/protocol/workflows/builtins/examples';
import { countWorkflowStepsV1 } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemGroupColumn, ItemGroupColumns } from '@/components/ui/lists/ItemGroupColumns';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { getPreferredLanguage, t, tLoose } from '@/text';
import { en } from '@/text/translations/en';
import { WorkflowFlowView } from '../flow/WorkflowFlowView';
import { projectWorkflowFlow } from '../flow/workflowFlowProjection';

/** The same read-only examples everywhere. Selection itself never writes or starts a Run. */
export function WorkflowExamplesSection(props: Readonly<{
    onUse?: (example: WorkflowStarterExampleV1) => void;
    /** Inline trigger selection is not a new editor draft. */
    opensDraft?: boolean;
}>): React.ReactElement {
    const router = useRouter();
    const useExample = (example: WorkflowStarterExampleV1) => {
        if (props.onUse) props.onUse(example);
        else router.push({ pathname: '/workflows/new', params: { example: example.key } } as never);
    };
    return <ItemGroup title={t('workflows.examples.title')} surface="none"
        {...(props.opensDraft === false ? {} : { description: t('workflows.examples.description') })}>
        <SectionContentRow showDivider={false}>
            <ItemGroupColumns columns={2} paddingHorizontal={0} paddingVertical={0}>
                {WORKFLOW_STARTER_EXAMPLES_V1.map((example) => <ItemGroupColumn key={example.key} style={styles.cell}>
                    <ExampleCard example={example} onUse={() => useExample(example)} />
                </ItemGroupColumn>)}
            </ItemGroupColumns>
        </SectionContentRow>
    </ItemGroup>;
}

/**
 * One example (lab `nav-N3`): what it does, the thing itself as its mini-map on a quiet band, and a
 * footer with the one fact that sizes it and its bordered **Use this**.
 */
function ExampleCard(props: Readonly<{ example: WorkflowStarterExampleV1; onUse: () => void }>) {
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
        <View style={styles.preview}>
            <WorkflowFlowView projection={projection} selectedNodeId={null} density="compact" testIDPrefix={`workflow-examples:${example.key}:flow`} />
        </View>
        <View style={styles.footer}>
            <Text style={styles.meta}>{[t('workflows.examples.stepCount', { count: stepCount }), shape].filter(Boolean).join(' · ')}</Text>
            <RoundButton testID={`workflow-examples:${example.key}:use`} size="small" display="secondary"
                title={t('workflows.examples.use')} accessibilityLabel={`${t('workflows.examples.use')}: ${tLoose(example.titleKey)}`} onPress={props.onUse} />
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
    // The example itself, on the canvas tone the visual tiles' previews use.
    preview: {
        flexGrow: 1,
        backgroundColor: theme.colors.background.canvas,
        padding: theme.margins.md,
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
}));
