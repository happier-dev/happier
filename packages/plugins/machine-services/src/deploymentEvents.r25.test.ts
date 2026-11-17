import { expect, it } from 'vitest';
import { deploymentEvents } from './deploymentEvents.js';

it.each([
    { localId: 'rollback-completed', actionId: 'deployments.rollback' },
    { localId: 'promotion-completed', actionId: 'deployments.promote' },
] as const)('declares the completed Action and outcome for $localId', ({ localId, actionId }) => {
    expect(deploymentEvents[localId]?.declaration.automation).toMatchObject({
        completesActionIds: [actionId], completionOutcome: 'succeeded',
    });
});
