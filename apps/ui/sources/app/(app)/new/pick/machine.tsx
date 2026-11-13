import React from 'react';

import { useMachinePickerScreenModel } from '@/components/sessions/new/hooks/machines/useMachinePickerScreenModel';
import { NewSessionPickerRouteScreen } from '@/components/sessions/new/navigation/NewSessionPickerRouteScreen';

export default React.memo(function MachinePickerScreen() {
    const { screenOptions, content } = useMachinePickerScreenModel();

    return <NewSessionPickerRouteScreen options={screenOptions}>{content}</NewSessionPickerRouteScreen>;
});
