import type { EnvironmentSecretBindingInputV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

/** Recovery compares approved intent; the binding writer owns persisted grant addresses. */
export function sameBindingIntent(
    stored: readonly EnvironmentSecretBindingInputV1[], intended: readonly EnvironmentSecretBindingInputV1[],
): boolean {
    const intent = (binding: EnvironmentSecretBindingInputV1) => {
        if (binding.purpose !== 'variable') return binding;
        const { grantRef: _grantRef, ...value } = binding;
        return value;
    };
    return sameStrictJsonValue(stored.map(intent), intended.map(intent));
}
