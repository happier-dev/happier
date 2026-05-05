import { listActionSpecs, type ActionId } from '@happier-dev/protocol';

import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';

export function listAgentInputActionChipActionIds(state: Readonly<{ settings?: unknown }>): readonly ActionId[] {
    return listActionSpecs()
        .filter((spec) => spec.surfaces.ui === true)
        .filter((spec) => Array.isArray(spec.placements) && spec.placements.includes('agent_input_chips' as any))
        .filter((spec) => isActionEnabledInState(state as any, spec.id, { surface: 'ui', placement: 'agent_input_chips' } as any))
        .map((spec) => spec.id);
}

