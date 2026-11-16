import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import type { WorkflowActionLeafV1, WorkflowDefinitionV1, WorkflowValueReference } from '@happier-dev/protocol/workflows';
import { MENTION_KIND_V1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createWorkflowCoordinator } from './coordinator';
import { buildWorkflowActionContext } from './workflowActionContext';
import { createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';

const event = { pluginId: 'example.pull-requests', localId: 'opened' };
const reference = { kind: 'trigger_event', event, path: ['title'] } satisfies WorkflowValueReference;
const workspace = { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' };

async function runMessage(admission: 'event' | 'manual', binding: 'text' | 'whole' | 'optional' = 'text', nested = false) {
  const mention = { kind: MENTION_KIND_V1.workflowInput, ref: 'workflowInput:0', label: 'Pull request title' };
  const token = { ...mention, token: formatInlineReferenceTokenV1(mention) };
  const leaf: WorkflowActionLeafV1 = { kind: 'action', id: 'message', actionId: 'session.message.send', input: {
    sessionId: { kind: 'literal', value: 'destination' }, reply: { kind: 'literal', value: 'none' },
    message: binding === 'whole' ? reference : binding === 'optional' ? { kind: 'literal', value: 'Review this pull request' }
      : { kind: 'text', document: { text: `PR: ${token.token}`, references: [token] }, input: [reference] },
    ...(binding === 'optional' ? { modelOverride: reference } : {}),
  } };
  const definition = { version: 1, defaults: {}, inputs: [], blocks: [leaf] } satisfies WorkflowDefinitionV1;
  const accepted = await materializeWorkflowAcceptedSnapshotV1({
    definition: nested ? { ...definition, blocks: [{ kind: 'workflow', id: 'nested', workflowRef: 'builtin:event-message', input: {} }] } : definition,
    context: { source: { kind: 'inline' }, inputs: {}, machineId: workspace.machineId, executionTarget: { kind: 'session' },
      workspaceTarget: { project: workspace }, authorization: { principal: { kind: 'host' } } },
    admission: admission === 'event' ? { kind: 'trigger', workDepth: 0,
      eventOccurrence: { event, payload: { title: 'Fix the build', unrelated: 'private' } },
      admitLeaf: async () => { throw new Error('Message does not admit an Agent'); } } : { kind: 'user' },
    effects: { resolveTargetAvailability: async () => true,
      readWorkflowDefinition: async () => ({ definition, sourceKey: 'builtin:event-message' }),
      resolveSessionTarget: async sessionId => typeof sessionId === 'string'
        ? { address: { serverId: 'home', sessionId }, machineId: workspace.machineId } : null,
      readActionContract: async () => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec('session.message.send'))) },
  });
  if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
  const messages: string[] = [];
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), sessionSendMessage: async request => {
    messages.push(request.message);
    return { status: 'accepted', localId: 'event-message' };
  } });
  const store = createInMemoryWorkflowCoordinatorStore();
  const coordinator = createWorkflowCoordinator({ store,
    executeStep: async () => { throw new Error('Message does not run an Agent'); },
    resolveWorkspace: async () => ({ ok: true, workspace }),
    action: { executor, buildContext: async params => buildWorkflowActionContext(params),
      observeRun: async () => { throw new Error('Message does not observe a Run'); } } });
  const result = await coordinator.run({ ...accepted.snapshot, runId: `event-${admission}-${binding}` });
  return { result, messages, store };
}

describe('Event-admitted workflow values through the coordinator', () => {
  it.each(['event', 'manual'] as const)('renders Message values for %s admission', async admission => {
    const { result, messages } = await runMessage(admission);
    expect(result).toMatchObject({ state: 'succeeded' });
    expect(messages).toEqual([admission === 'event' ? 'PR: Fix the build' : 'PR: ']);
  });

  it('fails an absent required whole Message binding before any send', async () => {
    const { result, messages, store } = await runMessage('manual', 'whole');
    expect(result).toMatchObject({ state: 'failed', reason: 'invalid_input' });
    expect(messages).toEqual([]);
    expect(store.list().find(row => row.blockId === 'message')).toMatchObject({ lifecycle: 'failed', reason: 'invalid_input' });
  });
  it('omits an absent optional whole Message binding', async () => {
    const { result, messages } = await runMessage('manual', 'optional');
    expect(result).toMatchObject({ state: 'succeeded' });
    expect(messages).toEqual(['Review this pull request']);
  });
  it('carries sealed Event values into a child Workflow frame', async () => {
    const { result, messages } = await runMessage('event', 'text', true);
    expect(result).toMatchObject({ state: 'succeeded' });
    expect(messages).toEqual(['PR: Fix the build']);
  });
});
