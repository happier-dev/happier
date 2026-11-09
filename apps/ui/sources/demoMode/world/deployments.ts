import type { DeploymentReadTransportV1 } from '@happier-dev/deployments';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployment-protocol/v1';
import {
    createDeploymentEnvironmentHeaderV1,
    createDeploymentReceiptHeaderV1,
} from '@happier-dev/deployment-protocol/testing/v1';

import { DEMO_MACHINE_ID, DEMO_NOW_MS, DEMO_SECONDARY_MACHINE_ID } from './constants';

/** A seeded read boundary for the real All deployments page; no deploy is submitted. */
export function buildDemoDeploymentTransport(): DeploymentReadTransportV1 {
    const entries = [
        { id: 'storefront-production', source: 'storefront', title: 'Production', machineId: DEMO_SECONDARY_MACHINE_ID,
            production: true, minutes: 4, state: 'running', version: null },
        { id: 'storefront-staging', source: 'storefront', title: 'Staging', machineId: DEMO_MACHINE_ID,
            production: false, minutes: 38, state: 'succeeded', version: 'Keep the cart after sign-in' },
        { id: 'payments-production', source: 'payments-api', title: 'Production API', machineId: DEMO_SECONDARY_MACHINE_ID,
            production: true, minutes: 64, state: 'succeeded', version: 'Webhook retry fix' },
        { id: 'docs-production', source: 'docs-site', title: 'Documentation', machineId: DEMO_SECONDARY_MACHINE_ID,
            production: true, minutes: 120, state: 'succeeded', version: 'New deployment guide' },
    ] as const;
    const items: DeploymentEnvironmentCollectionV1['items'] = entries.map(entry => ({
        environment: createDeploymentEnvironmentHeaderV1({
            id: entry.id,
            serverId: 'demo-home',
            owner: { kind: 'account', accountId: 'demo-account' },
            projectSourceId: entry.source,
            controllerMachineId: entry.machineId,
            buildMachineId: entry.machineId,
            protection: entry.production ? 'production' : 'nonProduction',
            updatedAtMs: DEMO_NOW_MS - entry.minutes * 60_000,
        }),
        title: entry.title,
        projectSourceName: entry.source,
        liveVersionTitle: entry.version,
        currentDeployment: {
            ...createDeploymentReceiptHeaderV1({
                id: `${entry.id}-latest`, environmentId: entry.id, state: entry.state,
                requestedAtMs: DEMO_NOW_MS - entry.minutes * 60_000,
                startedAtMs: DEMO_NOW_MS - entry.minutes * 60_000 + 1_000,
                settledAtMs: entry.state === 'succeeded' ? DEMO_NOW_MS - entry.minutes * 60_000 + 90_000 : undefined,
            }),
            ...(entry.state === 'running' ? { steps: [
                { id: 'sync', label: 'Sync', state: 'succeeded' as const, durationMs: 4_000 },
                { id: 'build', label: 'Build', state: 'running' as const },
                { id: 'rollout', label: 'Roll out', state: 'pending' as const },
                { id: 'route', label: 'Route', state: 'pending' as const },
            ] } : {}),
        },
    }));
    // Only the list is mounted. Unreached detail reads retain the transport's typed refusal.
    const detailNotSeeded = async () => ({ ok: false as const, failure: { code: 'deployment_unavailable', retryable: false } });
    return {
        listEnvironments: async () => ({ ok: true, value: { items, nextCursor: null, coverage: 'complete' } }),
        readEnvironment: detailNotSeeded,
        listHistory: detailNotSeeded,
        readReceipt: detailNotSeeded,
    };
}
