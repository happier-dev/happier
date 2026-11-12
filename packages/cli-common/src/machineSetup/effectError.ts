import type { MachineElevationFailureV1 } from '@happier-dev/protocol/machines/adminAccessV1';

export class MachineSetupEffectError extends Error {
    constructor(readonly reasonCode: 'foreign_effect_conflict' | 'validation_failed' | 'native_effect_failed' | 'package_manager_busy' | 'required_fact_unavailable' | 'needs_admin_to_check',
        readonly failure?: MachineElevationFailureV1) {
        super(reasonCode); this.name = 'MachineSetupEffectError';
    }
}
