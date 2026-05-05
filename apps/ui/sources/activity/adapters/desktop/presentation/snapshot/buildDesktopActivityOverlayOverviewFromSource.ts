import { buildActivityOverviewFromSource } from '@/activity/source/buildActivityOverviewFromSource';

import type { DesktopActivityOverlaySource } from '../../runtime/useDesktopActivityOverlaySource';

export function buildDesktopActivityOverlayOverviewFromSource(params: Readonly<{
    source: DesktopActivityOverlaySource;
    nowMs: number;
}>) {
    return buildActivityOverviewFromSource(params);
}
