import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ComputerUseSettingsSpecimen } from '@/components/dev/computer/ComputerUseSettingsSpecimen';

/** Dev-only: every state of a Machine's Computer use page. `?state=<name>` picks one (see the specimen). */
export default function ComputerUseSettingsDevScreen() {
    const params = useLocalSearchParams<{ state?: string }>();
    return <ComputerUseSettingsSpecimen state={typeof params.state === 'string' ? params.state : 'first'} />;
}
