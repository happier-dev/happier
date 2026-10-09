import { ManagedResourceDependencyV1Schema } from '@happier-dev/protocol/machines/managed/managedDependencyV1';

/** Safe removal-review bytes at the Home/daemon boundary; no launch or credential material. */
export function createManagedResourceDependencyFixture(intentRevision = 7) {
    const provider = { pluginId: 'example.compute', localId: 'cloud' };
    return ManagedResourceDependencyV1Schema.parse({
        managedId: 'managed-1', homeId: 'home-1', custodianAccountId: 'account-owner', intentRevision,
        controller: { machineId: 'controller-1', installationId: 'installation-1' },
        provider, allocation: 'may-exist',
        resource: { contributionRef: provider, schemaVersion: 1, value: { project: 'project-1', instance: 'native-1' } },
        nativeOperationRef: { contributionRef: provider, schemaVersion: 1, value: { operation: 'delete-1' } },
        recovery: { reference: 'native-1', reason: 'response_lost', consoleUrl: 'https://compute.example/resources/native-1' },
        observation: { observedAt: 1, availability: 'unavailable', billing: { location: 'cloud', stoppedBilling: 'unknown' } },
        cleanup: { disposition: 'pending', reason: 'response_lost' },
    });
}
