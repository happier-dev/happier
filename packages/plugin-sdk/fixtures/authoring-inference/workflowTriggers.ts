import type { PluginActionInputById, PluginActionResultById } from '@happier-dev/plugin-sdk/actions';

type WorkflowAddTarget = NonNullable<PluginActionInputById['workflow.trigger.add']['target']>;
type WorkflowUpdateTarget = NonNullable<PluginActionInputById['workflow.trigger.update']['patch']['target']>;
type SessionAddTarget = PluginActionInputById['session.trigger.add']['target'];
type SessionUpdateTarget = NonNullable<PluginActionInputById['session.trigger.update']['patch']['target']>;

const inline = {
  kind: 'inline',
  definition: {
    version: 1, inputs: [], defaults: {},
    blocks: [{ kind: 'wait', id: 'review', document: { text: 'Review the result', references: [], attachments: [] } }],
  },
} satisfies WorkflowAddTarget;

const workflowAdd: WorkflowAddTarget = inline;
const workflowUpdate: WorkflowUpdateTarget = inline;
const sessionAdd: SessionAddTarget = inline;
const sessionUpdate: SessionUpdateTarget = inline;
void [workflowAdd, workflowUpdate, sessionAdd, sessionUpdate];

declare const run: PluginActionResultById['workflow.run.get'];
// Recovery needs the accepted authored source, not its materialized execution definition.
const authoredBlocks = run.authoredDefinition.blocks;
const forgetInput = {} satisfies PluginActionInputById['account.encryption.historicalKey.forget'];
const forgetResult = { status: 'nothing_retained' } satisfies PluginActionResultById['account.encryption.historicalKey.forget'];
void [authoredBlocks, forgetInput, forgetResult];

const invalid = { ...inline, definition: { ...inline.definition, blocks: [{ kind: 'invalid-block', id: 'bad' }] } } as const;
// @ts-expect-error inline Workflow trigger add rejects an unknown block kind
const invalidWorkflowAdd: WorkflowAddTarget = invalid;
// @ts-expect-error inline Workflow trigger update rejects an unknown block kind
const invalidWorkflowUpdate: WorkflowUpdateTarget = invalid;
// @ts-expect-error inline Session trigger add rejects an unknown block kind
const invalidSessionAdd: SessionAddTarget = invalid;
// @ts-expect-error inline Session trigger update rejects an unknown block kind
const invalidSessionUpdate: SessionUpdateTarget = invalid;
void [invalidWorkflowAdd, invalidWorkflowUpdate, invalidSessionAdd, invalidSessionUpdate];
