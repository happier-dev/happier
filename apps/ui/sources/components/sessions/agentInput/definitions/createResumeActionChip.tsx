import * as React from 'react';
import type { View } from 'react-native';

import { hapticsLight } from '@/components/ui/theme/haptics';
import { t } from '@/text';

import { ResumeChip } from '../layout/ResumeChip';

export function createResumeActionChip(params: Readonly<{
    anchorRef: React.RefObject<View | null>;
    onPress?: () => void;
    blurInput: () => void;
    showLabel: boolean;
    agentLabel: string;
    resumeSessionId: string | null | undefined;
    resumeIsChecking?: boolean;
    tint: string;
    chipStyle: (pressed: boolean) => any;
    textStyle: any;
}>): React.ReactNode {
    if (!params.onPress) {
        return null;
    }

    const chipTitle = t('newSession.resume.chipOptional', { agent: params.agentLabel });

    return (
        <ResumeChip
            key="resume"
            anchorRef={params.anchorRef}
            onPress={() => {
                hapticsLight();
                params.blurInput();
                params.onPress?.();
            }}
            showLabel={params.showLabel}
            resumeSessionId={params.resumeSessionId}
            isChecking={params.resumeIsChecking === true}
            labelTitle={chipTitle}
            labelOptional={chipTitle}
            iconColor={params.tint}
            pressableStyle={params.chipStyle}
            textStyle={params.textStyle}
        />
    );
}
