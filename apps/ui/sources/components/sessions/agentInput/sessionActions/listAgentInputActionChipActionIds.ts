import { listUiActionSpecsForPlacement } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';

export function listAgentInputActionChipActionIds(state: Readonly<{ settings?: unknown }>): readonly ActionId[] {
    // Reads only the chip Actions' families; scanning the catalog evaluated every family before Home (P03-BOOT-CUT).
    return listUiActionSpecsForPlacement('agent_input_chips')
        .filter((spec) => isActionEnabledInState(state as any, spec.id, { surface: 'ui', placement: 'agent_input_chips' } as any))
        .map((spec) => spec.id);
}
