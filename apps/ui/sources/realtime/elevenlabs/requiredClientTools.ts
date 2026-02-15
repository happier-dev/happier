import { listVoiceToolActionSpecs } from '@happier-dev/protocol';

import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';

export type ElevenLabsRequiredClientToolSpec = Readonly<{
    name: string;
    description: string;
}>;

export function resolveElevenLabsRequiredClientTools(state: any): ElevenLabsRequiredClientToolSpec[] {
    return listVoiceToolActionSpecs()
        .filter((spec) => {
            const name = spec.bindings?.voiceClientToolName;
            if (typeof name !== 'string' || name.trim().length === 0) return false;
            return isActionEnabledInState(state as any, spec.id);
        })
        .map((spec) => {
            const name = String(spec.bindings?.voiceClientToolName ?? '').trim();
            return {
                name,
                description: (spec.description ?? spec.title ?? name).trim(),
            };
        });
}

