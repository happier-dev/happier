import { describe, expect, it, vi } from 'vitest';
import type { DeploymentEnvironmentHealthFeedV1 } from '../controller/deploymentReadControllerTypes.js';
import { createDeploymentProjectionV1 } from './deploymentStore.js';

describe('deployment projection', () => {
    it('retains a service identity when a sibling is inserted or reordered, while publishing its real health changes', () => {
        const projection = createDeploymentProjectionV1();
        const db = { serviceId: 'db', state: 'up' as const, observedAt: 100, reason: null };
        const web = { serviceId: 'web', state: 'up' as const, observedAt: 100, reason: null };
        const publish = (services: DeploymentEnvironmentHealthFeedV1['members'][number]['services']) => projection.publish({
            status: 'ready', failure: null, value: { environmentId: 'environment', status: 'ready', members: [
                { machineId: 'machine', installationId: 'installation', status: 'ready', services },
            ] } satisfies DeploymentEnvironmentHealthFeedV1,
        });
        const services = () => (projection.getSnapshot().value as DeploymentEnvironmentHealthFeedV1).members[0]!.services;
        publish([db]);
        const firstDb = services()[0];
        const publications = vi.fn();
        projection.subscribe(publications);
        publish([web, { ...db }]);
        expect(services()[1]).toBe(firstDb);
        const firstWeb = services()[0];
        publish([{ ...db }, { ...web }]);
        expect(services()[0]).toBe(firstDb);
        expect(services()[1]).toBe(firstWeb);
        publish([{ ...db, state: 'down', observedAt: 200, reason: 'not_ready' }, { ...web }]);
        expect(services()[0]).not.toBe(firstDb);
        expect(services()[0]).toMatchObject({ state: 'down', observedAt: 200 });
        expect(services()[1]).toBe(firstWeb);
        expect(publications).toHaveBeenCalledTimes(3);
    });
});
