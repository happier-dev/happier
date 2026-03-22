import { actionSpecToElevenLabsClientToolParameters, describeActionForVoiceTool, type JsonSchemaObject } from '@happier-dev/protocol';
import {
    resolveDisabledVoiceActionIdsFromState,
    resolveEnabledVoiceToolActionSpecsFromState,
} from '@/voice/tools/resolveDisabledVoiceActionIds';

export type ElevenLabsRequiredClientToolSpec = Readonly<{
    name: string;
    description: string;
    parameters: JsonSchemaObject;
}>;

export function resolveElevenLabsRequiredClientTools(state: any): ElevenLabsRequiredClientToolSpec[] {
    const enabledSpecs = resolveEnabledVoiceToolActionSpecsFromState(state as any);
    const disabledActionIds = resolveDisabledVoiceActionIdsFromState(state as any);
    const availableActionIds = enabledSpecs.map((spec) => spec.id);
    return enabledSpecs
        .map((spec) => {
            const name = String(spec.bindings?.voiceClientToolName ?? '').trim();
            const parameters = actionSpecToElevenLabsClientToolParameters(spec as any, { disabledActionIds, availableActionIds });
            return {
                name,
                description: describeActionForVoiceTool(spec as any).trim(),
                parameters,
            };
        });
}
