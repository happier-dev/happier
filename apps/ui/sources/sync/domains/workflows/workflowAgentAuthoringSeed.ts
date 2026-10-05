import type { WorkflowArtifactRevisionV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import type { PluginUiNewSessionSeedV1 } from '@happier-dev/protocol/plugins/ui';
import { t } from '@/text';

/**
 * The one seed builder for agent authoring (04 §4.7, 07 S22): visible, editable composer text the
 * person reads and sends as their own turn. It says the task in plain words and, for Edit, names
 * the workflow, its id and its revision with the one Action sentence 04 specifies; it ends where
 * the person types ("Help me create a workflow that ", "Help me change {workflow}: "). Actions and
 * the ordinary Session remain the execution owners; there is no hidden instruction.
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
        return { prompt: `${t('workflows.authoring.createPrompt')}\n\n${t('workflows.authoring.createLead')}` };
    }
    return {
        prompt: `${t('workflows.authoring.editPrompt', {
            name: input.name,
            definitionId: input.definitionId,
            headerVersion: input.revision.headerVersion,
            bodyVersion: input.revision.bodyVersion,
        })}\n\n${t('workflows.authoring.editLead', { name: input.name })}`,
    };
}
