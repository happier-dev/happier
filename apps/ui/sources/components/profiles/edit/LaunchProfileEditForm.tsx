import * as React from 'react';
import { isLaunchProfileV2, type AiLaunchProfile } from '@happier-dev/protocol';

import { ProfileEditForm, type ProfileEditFormProps } from './ProfileEditForm';
import { SlimProfileEditForm } from './SlimProfileEditForm';

export type LaunchProfileEditFormProps = Omit<ProfileEditFormProps, 'profile' | 'onSave'> & Readonly<{
    profile: AiLaunchProfile;
    onSave: (profile: AiLaunchProfile) => boolean;
}>;

export function LaunchProfileEditForm(props: LaunchProfileEditFormProps) {
    if (isLaunchProfileV2(props.profile)) {
        return <SlimProfileEditForm {...props} profile={props.profile} onSave={props.onSave} />;
    }
    return <ProfileEditForm {...props} profile={props.profile} onSave={props.onSave} />;
}
