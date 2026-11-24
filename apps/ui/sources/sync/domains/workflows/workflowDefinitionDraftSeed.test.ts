import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';

import { subjectStarterEventSeed } from '@/components/workflows/triggers/subjectTriggerStarters';
import { preparePluginWorkflowTemplateDraft, readWorkflowDefinitionDraftSeed } from './workflowDefinitionDraftSeed';

const lifetime = {
    scope: { serverId: 'home', accountId: 'owner' },
    isCurrent: () => true,
    onRetire: () => ({ dispose() {} }),
};

describe('plugin Workflow template drafts', () => {
    it('carries a subject’s known Run values and its deploy trigger into the private authoring copy', async () => {
        const deploymentEnvironment = { serverId: 'home', projectSourceId: 'billing-api', environmentId: 'production' };
        const eventSeed = subjectStarterEventSeed('deploymentSucceeded', { deploymentEnvironment, controllerMachineId: 'controller' });
        expect(eventSeed).toEqual({ eventRef: DEPLOYMENT_RECEIPT_EVENT_REFS_V1.succeeded, monitoringMachineId: 'controller',
            setupInput: { v: 1, serverId: 'home', environmentId: 'production' } });
        const definition = { version: 1, blocks: [] } as never;
        const route = await preparePluginWorkflowTemplateDraft({
            accountLifetime: lifetime as never,
            source: { title: 'Check a deployment for regressions', definition } as never,
            seed: { inputValues: { configuration: { serverId: 'home', environmentId: 'production' } }, eventSeed },
        });
        if (!route) throw new Error('Expected a draft route');
        expect(readWorkflowDefinitionDraftSeed(route.params.definitionDraftSeedId, lifetime.scope)).toEqual({
            name: 'Check a deployment for regressions', definition, initialView: 'sentence',
            inputValues: { configuration: { serverId: 'home', environmentId: 'production' } }, eventSeed,
        });
    });
});
