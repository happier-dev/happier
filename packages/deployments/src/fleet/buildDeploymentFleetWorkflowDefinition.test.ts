import { describe, expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { validateWorkflowDefinition } from '@happier-dev/protocol/workflows/workflowValidationV1';
import { buildDeploymentFleetWorkflowDefinition } from './buildDeploymentFleetWorkflowDefinition.js';

describe('Fleet Workflow authoring', () => {
    it('refuses to author a last-server removal before any destructive Workflow can run', () => {
        const header = createDeploymentTargetLinkHeaderV1();
        expect(() => buildDeploymentFleetWorkflowDefinition({ serverId: 'home', environment: createDeploymentEnvironmentDetailV1(),
            runtimeLink: { ...header, source: { kind: 'host', id: 'own-server' } }, requestId: 'remove-last',
            change: { kind: 'remove', machineId: header.machines[0]! },
        })).toThrow();
    });
    it('requires the selected immutable source when the link already has a serving receipt', () => {
        const header = createDeploymentTargetLinkHeaderV1();
        expect(() => buildDeploymentFleetWorkflowDefinition({ serverId: 'home', environment: createDeploymentEnvironmentDetailV1(),
            runtimeLink: { ...header, source: { kind: 'host', id: 'own-server' } }, requestId: 'add-d',
            change: { kind: 'add', member: { machineId: 'joining', installationId: 'joining-install' } },
        })).toThrow(TypeError);
    });
    it('appends the joining installation to ordered current membership and pins the selected release', () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const header = createDeploymentTargetLinkHeaderV1({ machines: ['first', 'last'], members: [
            { machineId: 'first', installationId: 'first-install', state: 'active' },
            { machineId: 'last', installationId: 'last-install', state: 'active' },
        ] });
        const runtimeLink = { ...header, source: { kind: 'host' as const, id: 'own-server' } };
        const receipt = createDeploymentReceiptDetailV1();
        const sourceIntent = receipt.content.sourceIntent.kind === 'repository'
            ? { ...receipt.content.sourceIntent, pullRequestHead: undefined }
            : { ...receipt.content.sourceIntent, publicFiles: undefined };
        const authored = buildDeploymentFleetWorkflowDefinition({ serverId: 'home', environment, runtimeLink,
            requestId: 'add-d', change: { kind: 'add', member: { machineId: 'joining', installationId: 'joining-install' },
                sourceIntent } });
        expect(() => normalizeStrictJsonValue(authored.inputs)).not.toThrow();
        expect(validateWorkflowDefinition(authored.definition)).toMatchObject({ valid: true, issues: [] });
        expect(authored.inputs.fleet).toMatchObject({ expectedRevision: environment.environment.revision,
            sourceLinkId: runtimeLink.id, sourceLinkRevision: runtimeLink.revision,
            machines: [{ machineId: 'first', installationId: 'first-install' },
                { machineId: 'last', installationId: 'last-install' },
                { machineId: 'joining', installationId: 'joining-install' }], sourceIntent: receipt.content.sourceIntent,
        });
        expect(runtimeLink.machines).toEqual(['first', 'last']);
    });

    it('authors removal with only the selected member and surviving installations in their original order', () => {
        const header = createDeploymentTargetLinkHeaderV1({ machines: ['first', 'departing', 'last'], members: [
            { machineId: 'first', installationId: 'first-install', state: 'active' },
            { machineId: 'departing', installationId: 'departing-install', state: 'active' },
            { machineId: 'last', installationId: 'last-install', state: 'active' },
        ] });
        const authored = buildDeploymentFleetWorkflowDefinition({ serverId: 'home', environment: createDeploymentEnvironmentDetailV1(),
            runtimeLink: { ...header, source: { kind: 'host', id: 'own-server' } }, requestId: 'remove-d',
            change: { kind: 'remove', machineId: 'departing' } });
        expect(validateWorkflowDefinition(authored.definition)).toMatchObject({ valid: true, issues: [] });
        expect(authored.inputs.fleet).toMatchObject({ removedMachineId: 'departing',
            machines: [{ machineId: 'first', installationId: 'first-install' },
                { machineId: 'last', installationId: 'last-install' }] });
    });
});
