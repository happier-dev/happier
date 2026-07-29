import * as React from 'react';

import { MachineSetupTextField } from '@/components/ui/forms/MachineSetupTextField';
import { TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';

export const ProviderManualModelsField = React.forwardRef<React.ElementRef<typeof TextInput>, Readonly<{
    value: string;
    onChangeText: (value: string) => void;
    editable?: boolean;
    errorText?: string | null;
}>>(function ProviderManualModelsField(props, ref) {
    return (
        <MachineSetupTextField
            ref={ref}
            testID="provider-manual-model-ids"
            label={t('settingsProviders.models.addFieldLabel')}
            value={props.value}
            placeholder={t('settingsProviders.models.addPlaceholder')}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            editable={props.editable}
            errorText={props.errorText ?? undefined}
            inputStyle={{ minHeight: 112, textAlignVertical: 'top' }}
            onChangeText={props.onChangeText}
        />
    );
});
