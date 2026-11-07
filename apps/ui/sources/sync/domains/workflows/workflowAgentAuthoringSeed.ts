import type { WorkflowArtifactRevisionV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import type { PluginUiNewSessionSeedV1 } from '@happier-dev/protocol/plugins/ui';
import { t } from '@/text';

/**
 * The one seed builder for agent authoring (04 §4.7, 07 S22). The composer text is the person's own
 * turn: only the plain lead they continue ("Help me create a workflow that ", "Help me change
 * {workflow}: "), ending in the space where they type. What the agent needs to act (the workflow's
 * id and revision, the Actions to use, "don't run it") travels beside it as the seed's
 * current-screen context, the visible attachment the agent reads as data. Actions and the ordinary
 * Session remain the execution owners.
 */
export function buildWorkflowAgentAuthoringSeed(input: Readonly<{ kind: 'create' }> | Readonly<{
    kind: 'edit'; name: string; definitionId: string; revision: WorkflowArtifactRevisionV1;
}> | Readonly<{
    kind: 'repeatable'; sessionId: string; serverId: string;
    message?: Readonly<{ id: string; text: string }>;
}>): PluginUiNewSessionSeedV1 & Readonly<{ prompt: string }> {
    if (input.kind === 'repeatable') {
        // It fills this same Session's composer, so "here" is the conversation itself.
        return {
            prompt: [
                t(input.message ? 'workflows.authoring.repeatableMessagePrompt' : 'workflows.authoring.repeatablePrompt'),
                ...(input.message ? [t('workflows.authoring.repeatableMessageSource', { text: input.message.text })] : []),
            ].join('\n\n'),
        };
    }
    if (input.kind === 'create') {
        const title = t('workflows.newWorkflow');
        return {
            prompt: t('workflows.authoring.createLead'),
            currentUiContext: {
                navigation: { area: 'workflows', screen: 'workflow-create', title, presentation: 'screen' },
                entity: { kind: 'workflow', label: title, summary: t('workflows.authoring.createPrompt') },
                commands: [],
            },
        };
    }
    const { definitionId, revision } = input;
    return {
        prompt: t('workflows.authoring.editLead', { name: input.name }),
        currentUiContext: {
            navigation: { area: 'workflows', screen: 'workflow-editor', title: input.name, presentation: 'screen' },
            entity: {
                kind: 'workflow',
                label: input.name,
                summary: t('workflows.authoring.editPrompt', {
                    name: input.name, definitionId,
                    headerVersion: revision.headerVersion, bodyVersion: revision.bodyVersion,
                }),
                reference: { definitionId, revision: { headerVersion: revision.headerVersion, bodyVersion: revision.bodyVersion } },
            },
            commands: [],
        },
    };
}
