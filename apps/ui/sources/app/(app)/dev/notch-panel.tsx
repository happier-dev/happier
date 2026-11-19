import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { NotchPanelSpecimen } from '@/components/dev/notch/NotchPanelSpecimen';

/** Dev-only: the desktop notch's open panel on its plane. `?only=list|ask|bot|idle` renders one section. */
export default function NotchPanelDevScreen() {
    const params = useLocalSearchParams<{ only?: string }>();
    return <NotchPanelSpecimen only={typeof params.only === 'string' ? params.only : null} />;
}
