import type { WorkflowBlock, WorkflowDefinitionV1 } from '../workflowV1.js';
import { document, input, literal, result } from './definitionParts.js';
import { DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, DEPLOYMENT_DEPLOY_ACTION_ID_V1,
  DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, DEPLOYMENT_TARGET_UNLINK_ACTION_ID_V1,
  DEPLOYMENT_TEARDOWN_ACTION_ID_V1 } from '../../deployments/deploymentActionIdsV1.js';

export { createDeploymentDataMoveWorkflowV1, type StatefulDeploymentMoveWorkflowInputV1,
  type DeploymentMoveHealthTargetV1 } from './deploymentDataMoveV1.js';

/** Stateless repository Move. Domain cutover and local-data restore are outside this starter. */
export function createDeploymentMoveWorkflowV1(): WorkflowDefinitionV1 {
  const operand = (field: string) => input('move', [field]);
  const address = { serverId: operand('serverId'), environmentId: operand('environmentId') };
  const retained = (id: string, text: string): WorkflowBlock => ({ kind: 'wait', id,
    name: 'Source retained', document: document(text) });
  return {
    version: 1, defaults: {}, inputs: [{ name: 'noLocalData', valueType: 'boolean', required: true,
      description: 'Explicitly confirm that this app has no local data to move.' }, { name: 'move', valueType: 'json', required: true,
      description: 'Reviewed stateless repository source receipt, exact source link and ordered replacement Machines, reference bindings and request keys. Local data is retained on the source.' }],
    blocks: [
      { kind: 'action', id: 'domains', name: 'Read the Environment Domains', actionId: 'deployments.domains.list', input: address },
      { kind: 'if', id: 'move', name: 'Move this stateless app without Domains', when: { kind: 'all', conditions: [
        { kind: 'compare', operator: 'eq', left: input('noLocalData'), right: literal(true) },
        { kind: 'compare', operator: 'eq', left: result('domains', ['domains']), right: literal([]) },
        { kind: 'compare', operator: 'eq', left: result('domains', ['nextCursor']), right: literal(null) },
      ] }, then: [
        { kind: 'action', id: 'link', name: 'Select the destination and retain the source', actionId: 'deployments.targets.link', input: {
          ...address, expectedRevision: operand('expectedRevision'), requestKey: operand('linkRequestKey'),
          targetId: operand('targetId'), role: literal('runtime'), targetKind: literal('ownServer'),
          replacesLinkId: operand('sourceLinkId'), expectedTargetLinkRevision: operand('sourceLinkRevision'), machines: operand('machines'),
        } },
        { kind: 'action', id: 'bindings', name: 'Prepare destination reference grants', actionId: DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, input: {
          ...address, expectedRevision: result('link', ['revision']), set: operand('bindings'), remove: literal([]),
        } },
        { kind: 'action', id: 'deploy', name: 'Deploy the exact source receipt revision', actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1, input: {
          ...address, targetLinkId: result('link', ['targetLinkId']), sourceIntent: operand('sourceIntent'), requestKey: operand('deployRequestKey'),
        } },
        { kind: 'if', id: 'destinationSettled', name: 'Verify the settled destination', when: {
          kind: 'compare', operator: 'eq', left: result('deploy', ['state']), right: literal('succeeded'),
        }, then: [
          { kind: 'action', id: 'services', name: 'Read the destination primary service', actionId: 'machines.services.list', input: {
            ...address, machineId: operand('destinationMachineId'), composeService: operand('primaryService'),
          } },
          { kind: 'if', id: 'destinationObserved', name: 'Verify the observed destination service', when: {
            kind: 'compare', operator: 'neq', left: result('services', ['services']), right: literal([]),
          }, then: [
          { kind: 'action', id: 'health', name: 'Check the destination health once', actionId: 'deployments.health.read', input: {
            ...address, targetLinkId: result('link', ['targetLinkId'], { kind: 'outer', levels: 2 }),
            deploymentId: result('deploy', ['deploymentId'], { kind: 'outer', levels: 2 }),
            machineId: operand('destinationMachineId'), installationId: operand('destinationInstallationId'),
            service: result('services', ['services', 0, 'deployment', 'service'], { kind: 'outer', levels: 1 }),
          } },
          { kind: 'if', id: 'destinationHealthy', name: 'Retire the source only after current healthy evidence', when: {
            kind: 'all', conditions: [
              { kind: 'compare', operator: 'eq', left: result('health', ['health']), right: literal('healthy') },
              { kind: 'compare', operator: 'eq', left: result('health', ['freshness']), right: literal('current') },
            ],
          }, then: [
            { kind: 'action', id: 'teardown', name: 'Retire only the replaced Machine and retain its data', actionId: DEPLOYMENT_TEARDOWN_ACTION_ID_V1, input: {
              ...address, targetLinkId: operand('sourceLinkId'), requestKey: operand('teardownRequestKey'), reason: literal('move'),
              machines: { kind: 'list', items: [operand('sourceMachineId')] }, volumes: literal([]),
            } },
            { kind: 'if', id: 'sourceRetired', name: 'Detach the source after teardown proof', when: {
              kind: 'compare', operator: 'eq', left: result('teardown', ['state']), right: literal('succeeded'),
            }, then: [
              { kind: 'action', id: 'current', name: 'Read the source link after teardown', actionId: DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, input: address },
              { kind: 'loop', id: 'sourceLink', name: 'Find the exact retained source link', repetition: {
                kind: 'items', items: result('current', ['targetLinks']), execution: 'sequential', failurePolicy: 'fail_stop',
              }, body: [{ kind: 'if', id: 'exactSource', name: 'Detach the reviewed source link', when: {
                kind: 'compare', operator: 'eq', left: { kind: 'item', field: 'value', path: ['id'] }, right: operand('sourceLinkId'),
              }, then: [{ kind: 'action', id: 'unlink', name: 'Complete Move with source teardown proof', actionId: DEPLOYMENT_TARGET_UNLINK_ACTION_ID_V1, input: {
                ...address, expectedRevision: result('current', ['environment', 'revision'], { kind: 'outer', levels: 2 }),
                requestKey: operand('unlinkRequestKey'), targetLinkId: operand('sourceLinkId'),
                expectedTargetLinkRevision: { kind: 'item', field: 'value', path: ['revision'] },
                teardownDeploymentId: result('teardown', ['deploymentId'], { kind: 'outer', levels: 3 }),
              } }], otherwise: [] }] },
            ], otherwise: [retained('teardownPending', 'Source teardown has not settled. Inspect its operation before continuing. Completing this review ends the Workflow without claiming the Move completed.')] },
          ], otherwise: [retained('healthRecovery', 'The destination is not currently verified healthy. The source is retained. Inspect destination health and stop this Run before retrying, or complete this review to end without completing the Move.')] },
          ], otherwise: [retained('serviceRecovery', 'The destination primary service has not been observed. The source is retained. Inspect the destination and stop this Run before retrying, or complete this review to end without completing the Move.')] },
        ], otherwise: [retained('deploymentPending', 'The destination deployment has not settled successfully. The source is retained. Inspect the deployment operation before retrying. Completing this review does not complete the Move.')] },
      ], otherwise: [retained('domainsUnsupported', 'This Move supports stateless repository apps without Domains. No Machines were changed. Keep the source and review its Domain routes before retrying.')] },
    ], finalOutput: result('move'),
  };
}
