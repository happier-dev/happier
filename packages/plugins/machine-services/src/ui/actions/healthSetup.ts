import { PluginError, type PluginClientApi } from '@happier-dev/plugin-sdk';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { createMachineServiceHealthSetupSeedV1, HEALTH_SETUP_OPEN_ACTION_ID,
    MachineServiceHealthSetupOpenInputV1Schema } from '../../healthSetup.js';

/** Authoring intent only: the mounted editor owns Configure, Save and materialization. */
export async function openMachineServiceHealthSetupV1(input: unknown, context: Readonly<{
    signal: AbortSignal;
    ui: Pick<PluginUiHostApi, 'openAutomationEvent'>;
}>) {
    if (context.signal.aborted) return { status: 'unavailable' as const };
    const parsed = MachineServiceHealthSetupOpenInputV1Schema.safeParse(input);
    if (!parsed.success) throw new PluginError({ code: 'health_setup_input_invalid' });
    await context.ui.openAutomationEvent(createMachineServiceHealthSetupSeedV1(parsed.data), { signal: context.signal });
    return { status: 'opened' as const };
}

export function activateHealthSetupClientActionsV1(api: PluginClientApi): void {
    api.actions.register(HEALTH_SETUP_OPEN_ACTION_ID, openMachineServiceHealthSetupV1);
}
