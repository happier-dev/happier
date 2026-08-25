import * as React from 'react';
import { isLaunchProfileV2, type AiLaunchProfile } from '@happier-dev/protocol';

import { ProfileEditForm, type ProfileEditFormProps } from './ProfileEditForm';
import { SlimProfileEditForm } from './SlimProfileEditForm';

export type LaunchProfileEditFormProps = Omit<ProfileEditFormProps, 'profile' | 'onSave'> & Readonly<{
    profile: AiLaunchProfile;
    onSave: (profile: AiLaunchProfile, secretBindings?: Readonly<Record<string, string>>) => boolean;
    /** Optional exact server context for V2 machine-scoped previews. */
    serverId?: string | null;
}>;

export function LaunchProfileEditForm(props: LaunchProfileEditFormProps) {
    if (isLaunchProfileV2(props.profile)) {
        return <SlimProfileEditForm {...props} profile={props.profile} onSave={props.onSave} />;
    }
    const { serverId: _serverId, ...legacyProps } = props;
    return <ProfileEditForm {...legacyProps} profile={props.profile} onSave={props.onSave} />;
}
