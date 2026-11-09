import type { ActionsService, PluginActionInputById, PluginActionWorkflowDefinitionV1 } from '@happier-dev/plugin-sdk/actions';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';

/** An external definition, consumed through the same descriptor catalog as core built-ins. */
export const externalWorkflowPattern = {
  version: 1,
  defaults: {},
  inputs: [
    { name: 'question', valueType: 'string', required: true },
    { name: 'participant', valueType: 'json', required: true, inputType: { hostType: 'agentParticipant' } },
  ],
  blocks: [{
    kind: 'step', id: 'answer', name: 'Independent answer',
    document: { text: 'Answer the supplied question using its selected Discussion context.', references: [], attachments: [] },
    execution: { participant: { kind: 'input', name: 'participant' } },
    input: [{ kind: 'input', name: 'question' }, { kind: 'discussion_context', scope: 'addressing_message' }],
    result: { kind: 'text' },
  }],
  finalOutput: { kind: 'result', producer: { blockId: 'answer', scope: { kind: 'current' } }, path: [] },
} satisfies PluginActionWorkflowDefinitionV1;

export const externalWorkflowPatternContribution = {
  title: 'Independent review',
  definition: externalWorkflowPattern,
};

/** Both physical SDK transports consume the same typed input; no host-private import. */
export type ExternalWorkflowStartInput = PluginActionInputById['workflow.run.start'];
/** Synthetic, fixed author-proof input; never used by a loaded product Session. */
export const externalWorkflowStartInput = {
  runId: '20000000-0000-4000-8000-000000000001',
  source: { kind: 'catalog', workflow: 'plugin:fixture.external-authoring/independent-review' },
  inputs: { question: 'Review the selected change.', participant: { kind: 'session', session: { serverId: 'home', sessionId: 'participant' } } },
  origin: { kind: 'discussion', discussion: { serverId: 'home', discussionId: 'discussion' }, addressingMessageId: 'question' },
  onComplete: { kind: 'originating_discussion' },
} satisfies ExternalWorkflowStartInput;
export const startExternalWorkflowThroughUi = (host: Pick<PluginUiHostApi, 'executeAction'>, input: ExternalWorkflowStartInput) =>
  host.executeAction('workflow.run.start', input);
export const pauseExternalWorkflowThroughUi = (host: Pick<PluginUiHostApi, 'executeAction'>, input: PluginActionInputById['workflow.run.pause']) =>
  host.executeAction('workflow.run.pause', input);
export const startExternalWorkflowThroughActions = (actions: ActionsService, input: ExternalWorkflowStartInput) =>
  actions.execute('workflow.run.start', input);
export const pauseExternalWorkflowThroughActions = (actions: ActionsService, input: PluginActionInputById['workflow.run.pause']) =>
  actions.execute('workflow.run.pause', input);
