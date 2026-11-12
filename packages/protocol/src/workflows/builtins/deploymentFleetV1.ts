import type { WorkflowBlock, WorkflowDefinitionV1 } from '../workflowV1.js';
import { document, input, literal, result } from './definitionParts.js';
import { DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, DEPLOYMENT_DEPLOY_ACTION_ID_V1,
    DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1, DEPLOYMENT_TEARDOWN_ACTION_ID_V1 } from '../../deployments/deploymentActionIdsV1.js';

/** Membership composes public Actions; native grant/setup/health/ingress and drain stay with their owners. */
export function createDeploymentFleetWorkflowV1(
    kind: 'add' | 'remove',
    options: Readonly<{ deployCurrentRelease: boolean; configureIngress?: boolean }> = { deployCurrentRelease: true },
): WorkflowDefinitionV1 {
    const operand = (field: string) => input('fleet', [field]);
    const address = { serverId: operand('serverId'), environmentId: operand('environmentId') };
    const replacement = {
        ...address, targetId: operand('targetId'), role: literal('runtime'), targetKind: literal('ownServer'),
        replacesLinkId: operand('sourceLinkId'), machines: operand('machines'), requestKey: operand('linkRequestKey'),
    };
    const add: WorkflowBlock[] = [
        { kind: 'action', id: 'link', name: 'Add the joining server to the ordered fleet', actionId: 'deployments.targets.link',
            input: { ...replacement, expectedRevision: operand('expectedRevision'),
                expectedTargetLinkRevision: operand('sourceLinkRevision') } },
        ...(options.configureIngress ? [{
            kind: 'action' as const, id: 'configure', name: 'Save the reviewed fleet ingress', actionId: DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1,
            input: { ...address, expectedRevision: result('link', ['revision']), contentArtifactId: operand('contentArtifactId'),
                contentHeaderVersion: operand('contentHeaderVersion'), contentBodyVersion: operand('contentBodyVersion'),
                patch: { kind: 'object' as const, fields: { ingress: operand('ingress') } } },
        }] : []),
        { kind: 'action', id: 'bindings', name: 'Prepare reference grants for the joining server', actionId: DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1,
            input: { ...address, expectedRevision: result(options.configureIngress ? 'configure' : 'link', ['revision']), set: operand('bindings'), remove: literal([]) } },
        ...(options.deployCurrentRelease ? [{
            kind: 'action' as const, id: 'deploy', name: 'Join using the exact current release', actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1,
            input: { ...address, targetLinkId: result('link', ['targetLinkId']), sourceIntent: operand('sourceIntent'),
                requestKey: operand('deployRequestKey') },
        }] : []),
    ];
    const remove: WorkflowBlock[] = [
        { kind: 'action', id: 'teardown', name: 'Drain ingress and retire only the selected server',
            actionId: DEPLOYMENT_TEARDOWN_ACTION_ID_V1, input: {
                ...address, targetLinkId: operand('sourceLinkId'), requestKey: operand('teardownRequestKey'), reason: literal('manual'),
                machines: { kind: 'list', items: [operand('removedMachineId')] }, volumes: literal([]),
            } },
        { kind: 'if', id: 'drained', name: 'Drop membership only after settled teardown proof', when: {
            kind: 'compare', operator: 'eq', left: result('teardown', ['state']), right: literal('succeeded'),
        }, then: [
            { kind: 'action', id: 'current', name: 'Read the retained link after teardown',
                actionId: DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, input: address },
            { kind: 'loop', id: 'currentLink', name: 'Find the reviewed runtime link', repetition: {
                kind: 'items', items: result('current', ['targetLinks']), execution: 'sequential', failurePolicy: 'fail_stop',
            }, body: [
                { kind: 'if', id: 'reviewedLink', name: 'Retain the common servers and drop the drained member', when: {
                    kind: 'compare', operator: 'eq', left: { kind: 'item', field: 'value', path: ['id'] }, right: operand('sourceLinkId'),
                }, then: [
                    { kind: 'action', id: 'link', name: 'Replace membership with the settled drain receipt', actionId: 'deployments.targets.link', input: {
                        ...replacement, expectedRevision: result('current', ['environment', 'revision'], { kind: 'outer', levels: 2 }),
                        expectedTargetLinkRevision: { kind: 'item', field: 'value', path: ['revision'] },
                        drainedDeploymentId: result('teardown', ['deploymentId'], { kind: 'outer', levels: 3 }),
                    } },
                ], otherwise: [] },
            ] },
        ], otherwise: [
            { kind: 'wait', id: 'retained', name: 'Server membership retained', document: document(
                'The server teardown has not settled successfully. Its membership and cleanup references remain available. Inspect the operation before retrying. Completing this review ends the Workflow without claiming the server was removed.',
            ) },
        ] },
    ];
    return {
        version: 1, defaults: {}, inputs: [{ name: 'fleet', valueType: 'json', required: true,
            description: 'Reviewed current ordered membership, exact serving source when deployed, reference bindings and request keys.' }],
        blocks: kind === 'add' ? add : remove,
        finalOutput: result(kind === 'add' ? options.deployCurrentRelease ? 'deploy' : 'bindings' : 'drained'),
    };
}
