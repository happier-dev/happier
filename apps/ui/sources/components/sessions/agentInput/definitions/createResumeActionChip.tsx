import * as React from 'react';

import { hapticsLight } from '@/components/ui/theme/haptics';
import { t } from '@/text';

import { ResumeChip } from '../layout/ResumeChip';

export function createResumeActionChip(params: Readonly<{
    onPress?: () => void;
    blurInput: () => void;
    showLabel: boolean;
    resumeSessionId: string | null | undefined;
    resumeIsChecking?: boolean;
    tint: string;
    chipStyle: (pressed: boolean) => any;
    textStyle: any;
}>): React.ReactNode {
    if (!params.onPress) {
        return null;
    }

    return (
        <ResumeChip
            key="resume"
            onPress={() => {
                hapticsLight();
                params.blurInput();
                params.onPress?.();
            }}
            showLabel={params.showLabel}
            resumeSessionId={params.resumeSessionId}
            isChecking={params.resumeIsChecking === true}
            labelTitle={t('newSession.resume.title')}
            labelOptional={t('newSession.resume.optional')}
            iconColor={params.tint}
            pressableStyle={params.chipStyle}
            textStyle={params.textStyle}
        />
    );
}
