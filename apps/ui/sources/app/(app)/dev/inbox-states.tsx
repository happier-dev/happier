import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { InboxStatesSpecimen } from '@/components/dev/inbox/InboxStatesSpecimen';

/** Dev-only: the Inbox Mentions view (lab V3 P4-Mp) through the real Inbox content. `?scene=mentions|failed`. */
export default function InboxStatesDevScreen() {
    const params = useLocalSearchParams<{ scene?: string }>();
    return <InboxStatesSpecimen scene={params.scene === 'failed' ? 'failed' : 'mentions'} />;
}
