import * as React from 'react';

import { isDevRouteEnabled } from '@/auth/routing/devRoutePolicy';
import TerminalQaScreen from '@/components/terminal/qa/TerminalQaScreen';

export default function TerminalQaDevRoute(): React.ReactElement | null {
    if (!isDevRouteEnabled()) return null;
    return <TerminalQaScreen />;
}
