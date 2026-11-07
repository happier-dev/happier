import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { BotTemplatesSpecimen } from '@/components/dev/botTemplates/BotTemplatesSpecimen';

/** Dev-only: Bot template surfaces on the round-2 lab's content. `?frame=card|pane|page|preview|info`. */
export default function BotTemplatesDevScreen() {
    const params = useLocalSearchParams<{ frame?: string }>();
    return <BotTemplatesSpecimen frame={typeof params.frame === 'string' ? params.frame : null} />;
}
