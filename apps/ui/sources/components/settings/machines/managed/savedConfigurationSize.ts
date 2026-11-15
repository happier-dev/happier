import { resolveEffectiveActionInputFields, type ActionInputHints } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { readInputPath } from '@happier-dev/protocol/inputs';
import type { ValidatedLaunchSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';

type Size = NonNullable<NonNullable<ManagedConfigurationFactsV1['nativeFacts']>['size']>;

/** Interpret only declared roles on saved choices, using the shared field visibility rules. */
export function savedConfigurationSize(launch: ValidatedLaunchSnapshotV1, inputHints?: ActionInputHints): Size | undefined {
    const dimensions: Pick<Size, 'cpuCores' | 'memoryBytes' | 'diskBytes'> = {};
    for (const field of resolveEffectiveActionInputFields({ inputHints }, launch.choices)) {
        if (!field.role) continue;
        const value = readInputPath(launch.choices, field.path);
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
        const amount = field.unit === 'bytes' ? value : value * 1024 ** 3;
        switch (field.role) {
            case 'cpu': dimensions.cpuCores = value; break;
            case 'memory': dimensions.memoryBytes = amount; break;
            case 'disk': dimensions.diskBytes = amount; break;
        }
    }
    return Object.keys(dimensions).length ? { id: 'saved-options', title: launch.name, ...dimensions } : undefined;
}
