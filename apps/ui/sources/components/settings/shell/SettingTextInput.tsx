import * as React from 'react';
import { useHappierFieldValueDraft } from '@happier-dev/plugin-ui/presentation';

import { FieldTextInput, type FieldTextInputProps } from '@/components/ui/forms/FieldTextInput';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { accountSettingsScopeKeySuffix } from '@/sync/domains/settings/scope/accountSettingsScope';

type SettingTextInputProps = Omit<FieldTextInputProps,
    'onChangeText' | 'onBlur' | 'onSubmitEditing' | 'onKeyPress'> & Readonly<{
        onCommit: (value: string) => string | void | Promise<boolean>;
        /** Uses the setting's saved-text contract without changing authored drafts while typing. */
        normalize?: (draft: string) => string;
        /** Existing live guidance stays next to the field, subscribed to its local draft. */
        supportingContent?: (draft: string) => React.ReactNode;
    }>;

/** Keeps editing local to the field; the caller's existing settings Action owns the completed edit. */
export const SettingTextInput = React.memo(function SettingTextInput(props: SettingTextInputProps) {
    const scope = useAccountSettingsScope();
    return <ScopedSettingTextInput key={scope ? accountSettingsScopeKeySuffix(scope) : 'local'} {...props} />;
});

function ScopedSettingTextInput(props: SettingTextInputProps) {
    const { value, onCommit, normalize, supportingContent, ...fieldProps } = props;
    const field = useHappierFieldValueDraft({ value, onCommit, normalize, trim: false });
    return <><FieldTextInput {...fieldProps} value={field.draft} onChangeText={field.change}
        onBlur={field.commit} onSubmitEditing={field.commit}
        onKeyPress={event => { if (event.nativeEvent.key === 'Escape') field.cancel(); }} />
        {supportingContent?.(field.draft)}</>;
}
