import { t } from '@/text';
import type { SessionConfigOptionControl } from '@/sync/domains/sessionControl/configOptionsControl';

import type { ModelOption } from './modelOptions';

export const EXTENDED_CONTEXT_MODEL_TOGGLE_OPTION_ID = 'extended_context_model';

export function buildExtendedContextModelControl(params: Readonly<{
    model: ModelOption | null | undefined;
    effectiveModelId: string | null | undefined;
}>): SessionConfigOptionControl | null {
    const extendedContextModelId = params.model?.extendedContextModelId;
    if (!extendedContextModelId) return null;
    const value = params.effectiveModelId === extendedContextModelId ? 'true' : 'false';
    return {
        option: {
            id: EXTENDED_CONTEXT_MODEL_TOGGLE_OPTION_ID,
            name: t('agentInput.model.extendedContextToggleLabel'),
            description: t('agentInput.model.extendedContextToggleDescription'),
            type: 'boolean',
            currentValue: value,
        },
        effectiveValue: value,
        isPending: false,
    };
}

export function resolveExtendedContextModelIdForToggle(params: Readonly<{
    model: ModelOption | null | undefined;
    enabled: boolean;
}>): string | null {
    if (!params.model?.extendedContextModelId) return null;
    return params.enabled ? params.model.extendedContextModelId : params.model.value;
}
