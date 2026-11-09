import { Stack } from 'expo-router';
import * as React from 'react';

import { ScreenCaptureSpecimen } from '@/components/screenCapture/dev/ScreenCaptureSpecimen';

const SCREEN_OPTIONS = { headerShown: false } as const;

export default function ScreenCaptureDevScreen() {
    return (
        <>
            <Stack.Screen options={SCREEN_OPTIONS} />
            <ScreenCaptureSpecimen />
        </>
    );
}
