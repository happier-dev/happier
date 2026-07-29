import * as React from 'react';

import { isDevRouteEnabled } from '@/auth/routing/devRoutePolicy';
import { VoiceLabScreen } from '@/components/dev/voiceLab/VoiceLabScreen';

export default function VoiceLabDevRoute(): React.ReactElement | null {
    if (!isDevRouteEnabled()) return null;
    return <VoiceLabScreen />;
}
