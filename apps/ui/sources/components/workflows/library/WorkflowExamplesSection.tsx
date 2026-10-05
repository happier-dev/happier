import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { WORKFLOW_STARTER_EXAMPLES_V1, type WorkflowStarterExampleV1 } from '@happier-dev/protocol';
import { countWorkflowStepsV1 } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t, tLoose } from '@/text';
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
    return <ItemGroup title={t('workflows.examples.title')} columns={2}
        {...(props.opensDraft === false ? {} : { description: t('workflows.examples.description') })}>
        {WORKFLOW_STARTER_EXAMPLES_V1.map((example) => <ExampleCard key={example.key} example={example} onUse={() => useExample(example)} />)}
    </ItemGroup>;
}

/**
 * One example (lab `nav-N3`): what it does, the thing itself as its mini-map on a quiet band, and a
 * footer with the one fact that sizes it and its bordered **Use this**.
 */
function ExampleCard(props: Readonly<{ example: WorkflowStarterExampleV1; onUse: () => void }>) {
    const { example } = props;
    const projection = React.useMemo(() => projectWorkflowFlow(example.definition), [example.definition]);
    const stepCount = React.useMemo(
        () => countWorkflowStepsV1(example.definition.blocks),
        [example.definition],
    );
    return <SectionContentRow testID={`workflow-examples:${example.key}`} showDivider={false}><View style={styles.card}>
        <View style={styles.copy}>
            <Text style={styles.title}>{tLoose(example.titleKey)}</Text>
            <Text style={styles.description}>{tLoose(example.descriptionKey)}</Text>
        </View>
        <View style={styles.preview}>
            <WorkflowFlowView projection={projection} selectedNodeId={null} density="compact" testIDPrefix={`workflow-examples:${example.key}:flow`} />
        </View>
        <View style={styles.footer}>
            <Text style={styles.meta} numberOfLines={1}>{t('workflows.examples.stepCount', { count: stepCount })}</Text>
            <RoundButton testID={`workflow-examples:${example.key}:use`} size="small" display="secondary"
                title={t('workflows.examples.use')} accessibilityLabel={`${t('workflows.examples.use')}: ${tLoose(example.titleKey)}`} onPress={props.onUse} />
        </View>
    </View></SectionContentRow>;
}

const styles = StyleSheet.create((theme) => ({
    card: { flexGrow: 1, minWidth: 0, gap: theme.margins.md },
    copy: { gap: theme.margins.xs },
    title: { ...Typography.default('semiBold'), color: theme.colors.text.primary },
    description: { ...Typography.default(), color: theme.colors.text.secondary },
    // The example itself, on the canvas tone the visual tiles' previews use.
    preview: {
        backgroundColor: theme.colors.background.canvas,
        borderRadius: theme.borderRadius.md,
        padding: theme.margins.sm,
    },
    footer: { marginTop: 'auto', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.margins.sm },
    meta: { ...Typography.default(), flexShrink: 1, color: theme.colors.text.tertiary },
}));
