import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { TriggerPopoverSpecimen } from '@/components/dev/workflows/TriggerPopoverSpecimen';

/** Dev-only: the trigger popover on a saved Account schedule. `?scene=daily|hourly|new`. */
export default function TriggerPopoverDevScreen() {
    const params = useLocalSearchParams<{ scene?: string }>();
    return <TriggerPopoverSpecimen scene={params.scene === 'hourly' || params.scene === 'new' ? params.scene : 'daily'} />;
}
