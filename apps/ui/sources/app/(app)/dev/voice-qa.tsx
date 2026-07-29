import * as React from 'react';

import { isDevRouteEnabled } from '@/auth/routing/devRoutePolicy';
import VoiceQaScreen from '@/components/voice/qa/VoiceQaScreen';

export default function VoiceQaDevRoute(): React.ReactElement | null {
    if (!isDevRouteEnabled()) return null;
    return <VoiceQaScreen />;
}
