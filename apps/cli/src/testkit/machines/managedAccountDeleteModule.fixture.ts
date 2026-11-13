import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { managedCustodyDefaultActionIds } from '../../plugins/runtime/invocation/actions/managedCustody.actionIds.testkit';

/** Authored native effect boundary; foreground deletion and Home settlement stay real. */
export function activate(api: PluginAccountApi) {
    for (const id of managedCustodyDefaultActionIds) {
        api.actions.register(id, async () => {
            if (id !== 'destroy') throw new Error(`Unexpected native role: ${id}`);
            return { kind: 'confirmed' };
        });
    }
}
