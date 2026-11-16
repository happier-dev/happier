import { buildMoveWorkflowDefinition } from './buildMoveWorkflowDefinition';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { describe, expect, it } from 'vitest';
import { validateWorkflowDefinition } from '@happier-dev/protocol/workflows/workflowValidationV1';
import { getWorkflowStarterExamplesV1 } from '@happier-dev/protocol/workflows/builtins/examples';
import type { StatefulDeploymentMoveWorkflowInputV1 } from '@happier-dev/protocol/workflows/builtins/deploymentMoveV1';

describe('Machine Move Workflow authoring', () => {
    it('authors the same stateful starter with the exact reviewed operands and stable deploy request key', () => {
        const reviewed: StatefulDeploymentMoveWorkflowInputV1 = {
            kind: 'stateful', serverId: 'home', requestId: 'data-move', writers: [{ machineId: 'source', serviceId: 'app', expectedGeneration: 'generation' }],
            backupTarget: { serverId: 'home', environmentId: 'source-env', machineId: 'source', installationId: 'source-install',
                targetLinkId: 'source-link', deploymentId: 'source-deploy', expectedRevision: 1, configRevision: 1 },
            sourceId: 'postgres', origin: { environmentId: 'source-env', targetLinkId: 'source-link' },
            restoreTarget: { serverId: 'home', environmentId: 'dest-env', machineId: 'destination', installationId: 'dest-install',
                targetLinkId: 'dest-link', deploymentId: 'source-deploy', expectedRevision: 1,
                destination: { kind: 'database', service: 'postgres', database: 'app' } },
            cutover: { serverId: 'home', environmentId: 'source-env', expectedRevision: 1,
                contentArtifactId: 'reviewed-connect-patch', contentHeaderVersion: 1, contentBodyVersion: 1 },
            deploy: { serverId: 'home', environmentId: 'source-env', targetLinkId: 'source-link' },
            health: { environmentId: 'dest-env', machineId: 'destination', installationId: 'dest-install',
                targetLinkId: 'dest-link', deploymentId: 'dest-deploy', composeService: 'postgres' },
        };
        const authored = buildMoveWorkflowDefinition(reviewed);
        expect(validateWorkflowDefinition(authored.definition)).toMatchObject({ valid: true, issues: [] });
        expect(authored.inputs).toEqual({ dataMove: { ...reviewed,
            deploy: { ...reviewed.deploy, requestKey: 'data-move:deploy' } } });
        expect(reviewed.deploy.requestKey).toBeUndefined();
    });
    it('offers an executable Machine Move through the agent starter catalog', () => {
        const starter = getWorkflowStarterExamplesV1().find(example => String(example.key) === 'deployment-move');
        expect(starter, 'Machine Move is reachable through the same public starter used by agents').toBeDefined();
        expect(validateWorkflowDefinition(starter?.definition)).toMatchObject({ valid: true, issues: [] });
    });
    it('replaces the selected member in order without changing common Machines or the exact source commit', () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const sourceLink = createDeploymentTargetLinkHeaderV1({ machines: ['first', 'source', 'last'], members: [
            { machineId: 'first', installationId: 'first-install', state: 'active' },
            { machineId: 'source', installationId: 'source-install', state: 'active' },
            { machineId: 'last', installationId: 'last-install', state: 'active' },
        ] });
        const sourceIntent = { kind: 'repository' as const, projectSourceId: 'source-app', sourceRevision: 2,
            sha: 'a'.repeat(40), compose: { path: 'compose.yaml', profiles: [], services: [], primaryService: 'app' } };
        const authored = buildMoveWorkflowDefinition({ environment, serverId: 'home',
            sourceLink: { ...sourceLink, source: { kind: 'host', id: 'own-server' } },
            sourceDeploymentId: 'source-receipt', sourceIntent, primaryService: 'app', sourceMachineId: 'source',
            destination: { machineId: 'destination', installationId: 'destination-install' }, requestId: 'move',
        });
        expect(authored.inputs.move.machines).toEqual([
            { machineId: 'first', installationId: 'first-install' },
            { machineId: 'destination', installationId: 'destination-install' },
            { machineId: 'last', installationId: 'last-install' },
        ]);
        expect(authored.inputs.move.sourceIntent).toEqual(sourceIntent);
        expect(sourceLink.machines).toEqual(['first', 'source', 'last']);
        expect(authored.definition).toEqual(getWorkflowStarterExamplesV1().find(example => String(example.key) === 'deployment-move')?.definition);
    });
});
