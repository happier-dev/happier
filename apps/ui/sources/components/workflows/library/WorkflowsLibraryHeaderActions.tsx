import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { buildWorkflowAgentAuthoringSeed } from '@/sync/domains/workflows/workflowAgentAuthoringSeed';
import { t } from '@/text';

import { useWorkflowAgentAuthoring } from '../authoring/useWorkflowAgentAuthoring';
import { WORKFLOWS_IMPORT_ROUTE, WORKFLOWS_NEW_ROUTE } from '../workflowsRoutes';

/**
 * The library's creation actions: Import and Create with an agent (quiet), then the one primary New workflow.
 * The home's header and the column's page-form header (FIN-DESIGN-REVIEW L6) draw the same row.
 */
export function WorkflowsLibraryHeaderActions(props: Readonly<{
    /** Import and Create with an agent; left out where the column's own "+" carries them. */
    secondary: boolean;
    controlRef?: React.ComponentProps<typeof RoundButton>['controlRef'];
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const router = useRouter();
    const openAgent = useWorkflowAgentAuthoring();
    return (
        <View style={styles.headerActions}>
            {props.secondary ? <><RoundButton
                testID="workflows-home:import"
                display="inverted"
                title={t('workflows.destination.import')}
                leading={<Icon name="download" size={14} color={theme.colors.text.secondary} />}
                textStyle={{ color: theme.colors.text.secondary }}
                onPress={() => router.pushRetainingCurrent(WORKFLOWS_IMPORT_ROUTE as never)}
            />
            <RoundButton testID="workflows-home:agent" display="secondary"
                title={t('workflows.authoring.create')}
                leading={<Icon name="sparkle" size={14} color={theme.colors.text.primary} />}
                onPress={() => openAgent(buildWorkflowAgentAuthoringSeed({ kind: 'create' }))} /></> : null}
            <RoundButton
                testID="workflows-home:new"
                {...(props.controlRef === undefined ? {} : { controlRef: props.controlRef })}
                title={t('workflows.newWorkflow')}
                leading={<Icon name="plus" size={14} color={theme.colors.button.primary.tint} />}
                onPress={() => router.push(WORKFLOWS_NEW_ROUTE as never)}
            />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    headerActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
        alignItems: 'center',
        gap: theme.space.s8,
    },
}));
