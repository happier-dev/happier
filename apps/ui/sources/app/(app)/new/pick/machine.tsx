import React from 'react';
import { Stack } from 'expo-router';

import { useMachinePickerScreenModel } from '@/components/sessions/new/hooks/machines/useMachinePickerScreenModel';

export default React.memo(function MachinePickerScreen() {
    const { screenOptions, content } = useMachinePickerScreenModel();

    return (
        <>
            <Stack.Screen options={screenOptions} />
            {content}
        </>
    );
});
