import * as React from 'react';
import { View } from 'react-native';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { useWorkflowsAvailability } from '@/components/workflows/gating/workflowsAvailability';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storeWorkflowAgentRevision } from '@/sync/domains/workflows/workflowAgentRevision';
import { createWorkflowDefinitionRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { useSessionTranscriptSource } from '../source/SessionTranscriptSourceContext';
import { resolveTranscriptWorkflowDefinitionReference, type TranscriptWorkflowDefinitionReference } from './transcriptWorkflowDefinitionReference';
import { t } from '@/text';

export const WorkflowDefinitionActionResultReference = React.memo(function WorkflowDefinitionActionResultReference(props: Readonly<{
    tool: ToolCall; serverId?: string | null;
}>) {
    const revision = React.useMemo(() => resolveTranscriptWorkflowDefinitionReference(props.tool), [props.tool]);
    if (revision === null || !props.serverId) return null;
    return <SavedWorkflowReference revision={revision} serverId={props.serverId} />;
});

function SavedWorkflowReference(props: Readonly<{ revision: TranscriptWorkflowDefinitionReference; serverId: string }>) {
    const source = useSessionTranscriptSource();
    const scope = useActiveServerAccountScope();
    const available = useWorkflowsAvailability().available;
    if (!available || !scope || !areServerProfileIdentifiersEquivalent(scope.serverId, props.serverId) || !source.navigate) return null;
    const revision = props.revision;
    const title = revision.actionId === 'workflow.definition.create'
        ? t('workflows.authoring.savedWorkflow', { name: revision.metadata.title })
        : revision.actionId === 'workflow.definition.edit'
            ? t('workflows.authoring.changed', { count: revision.changedBlockIds.length })
            : t('workflows.authoring.updated');
    return <View testID={`transcript-workflow-definition:${revision.definitionId}`}>
        <Text>{title}</Text>
        <RoundButton size="small" display="inverted" title={t('workflows.authoring.openEditor')}
            testID={`transcript-workflow-definition:${revision.definitionId}:open`}
            onPress={() => {
                const lifetime = captureActiveServerAccountScopeLifetime();
                if (!lifetime?.isCurrent() || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, props.serverId)) return;
                const seedId = storeWorkflowAgentRevision(revision, source.sessionId);
                source.navigate?.(`${createWorkflowDefinitionRoute(revision.definitionId)}?agentRevisionSeedId=${encodeURIComponent(seedId)}&authoringSessionId=${encodeURIComponent(source.sessionId)}`);
            }} />
    </View>;
}
