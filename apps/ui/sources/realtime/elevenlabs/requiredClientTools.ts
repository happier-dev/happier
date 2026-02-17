import { actionSpecToElevenLabsClientToolParameters, listVoiceToolActionSpecs, type JsonSchemaObject } from '@happier-dev/protocol';

import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';

export type ElevenLabsRequiredClientToolSpec = Readonly<{
    name: string;
    description: string;
    parameters: JsonSchemaObject;
}>;

export function resolveElevenLabsRequiredClientTools(state: any): ElevenLabsRequiredClientToolSpec[] {
    const shareDeviceInventory = (state as any)?.settings?.voice?.privacy?.shareDeviceInventory !== false;
    const inventoryActionIds = new Set<string>([
        'workspaces.list_recent',
        'paths.list_recent',
        'machines.list',
        'servers.list',
    ]);
    return listVoiceToolActionSpecs()
        .filter((spec) => {
            const name = spec.bindings?.voiceClientToolName;
            if (typeof name !== 'string' || name.trim().length === 0) return false;
            if (!shareDeviceInventory && inventoryActionIds.has(spec.id)) return false;
            // ElevenLabs required client tools must respect per-surface disablement so
            // "voice-only" setups never provision tools the user has turned off.
            return isActionEnabledInState(state as any, spec.id, { surface: 'voice_tool' });
        })
        .map((spec) => {
            const name = String(spec.bindings?.voiceClientToolName ?? '').trim();
            const parameters = actionSpecToElevenLabsClientToolParameters(spec as any);
            return {
                name,
                description: (spec.description ?? spec.title ?? name).trim(),
                parameters,
            };
        });
}
