import * as React from 'react';
import type { ProviderReasoningEffortLevelV1 } from '@happier-dev/protocol/providers/catalog/reasoningEffort';

import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';
import { ProviderReasoningEffortField } from './ProviderReasoningEffortField';

/**
 * Manual model ids, one per line: the page's multiline field, with its refusal beneath it and the
 * optional reasoning-effort levels the added models support.
 */
export const ProviderManualModelsField = React.forwardRef<React.ElementRef<typeof TextInput>, Readonly<{
    value: string;
    onChangeText: (value: string) => void;
    reasoningEffortLevels: readonly ProviderReasoningEffortLevelV1[];
    onReasoningEffortLevelsChange: (levels: ProviderReasoningEffortLevelV1[]) => void;
    editable?: boolean;
    errorText?: string | null;
}>>(function ProviderManualModelsField(props, ref) {
    return (
        <>
            <FieldTextInput
                ref={ref}
                testID="provider-manual-model-ids"
                accessibilityLabel={t('settingsProviders.models.addFieldLabel')}
                value={props.value}
                placeholder={t('settingsProviders.models.addPlaceholder')}
                multiline
                monospace
                minLines={4}
                editable={props.editable}
                error={props.errorText ?? undefined}
                onChangeText={props.onChangeText}
            />
            <ProviderReasoningEffortField
                testID="provider-manual-model-effort"
                levels={props.reasoningEffortLevels}
                disabled={props.editable === false}
                onChange={props.onReasoningEffortLevelsChange}
            />
        </>
    );
});
