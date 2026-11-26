import * as React from 'react';
import { ScmGitIdentitySchema } from '@happier-dev/protocol/scm/gitIdentity';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { InlineFormActions } from '@/components/ui/forms/InlineAddExpander';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { useSetting } from '@/sync/domains/state/storage';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { accountSettingsScopeKeySuffix } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';
import { SOURCE_CONTROL_SETTINGS } from './sourceControlSettings';
import { useMountedRef } from '@/hooks/ui/useMountedRef';

type GitIdentitySettingProps = Readonly<{
    presentation?: 'setting' | 'commit';
    serverId?: string;
    initialValue?: Readonly<{ name: string; email: string }>;
    saveLabel?: string;
    onSaved?: () => Promise<void>;
}>;

export function GitIdentitySetting(props: GitIdentitySettingProps) {
    const scope = useAccountSettingsScope();
    return <GitIdentityFields key={scope ? accountSettingsScopeKeySuffix(scope) : 'unavailable'} {...props} />;
}

// Drafts stay beside the fields, never rerendering the settings page while typing.
function GitIdentityFields(props: GitIdentitySettingProps) {
    const identity = useSetting('scmGitIdentity');
    const { setSetting, ready, isCurrent } = useSettingActionFeedback({ serverId: props.serverId });
    const mountedRef = useMountedRef();
    const [draft, setDraft] = React.useState<{ name: string; email: string } | null>(null);
    const [saving, setSaving] = React.useState(false);
    const value = draft ?? identity ?? props.initialValue ?? { name: '', email: '' };
    const empty = !value.name.trim() && !value.email.trim();
    const parsed = ScmGitIdentitySchema.safeParse(value);
    const valid = empty ? props.presentation !== 'commit' : parsed.success;
    const setting = SOURCE_CONTROL_SETTINGS.settings.gitIdentity;
    const save = async () => {
        if (!valid) return;
        setSaving(true);
        try {
            if (await setSetting(setting, empty ? null : parsed.data!) && mountedRef.current) {
                setDraft(null);
                await props.onSaved?.();
            }
        } finally { if (mountedRef.current) setSaving(false); }
    };
    const fields = <>
            <FieldItem label={t('common.name')}>
                <FieldTextInput testID="settings.sourceControl.gitIdentity.name" accessibilityLabel={t('common.name')}
                    value={value.name} editable={!saving} onChangeText={name => setDraft({ ...value, name })} />
            </FieldItem>
            <FieldItem label={t('settingsSourceControl.gitIdentity.email')}>
                <FieldTextInput testID="settings.sourceControl.gitIdentity.email" accessibilityLabel={t('settingsSourceControl.gitIdentity.email')}
                    value={value.email} editable={!saving} autoCapitalize="none" keyboardType="email-address"
                    onChangeText={email => setDraft(current => ({ ...(current ?? value), email }))} />
            </FieldItem>
            <InlineFormActions saveLabel={props.saveLabel ?? t('common.save')} cancelLabel={t('common.cancel')}
                saveTestID="settings.sourceControl.gitIdentity.save" saveDisabled={!ready || !isCurrent(setting) || saving || !valid}
                saving={saving} onSave={() => { void save(); }} onCancel={() => setDraft(null)} />
        </>;
    return props.presentation === 'commit' ? fields : <SettingRow setting={setting} subtitleLines={0}
        accessoryLayout="stacked" showChevron={false} rightElement={fields} />;
}
