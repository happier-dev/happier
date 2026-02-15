import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';

import type { ServerSelectionTarget } from './serverSelectionTypes';

export function getServerSelectionTargetIconName(target: ServerSelectionTarget): 'server-outline' | 'albums-outline' {
    return target.kind === 'group' ? 'albums-outline' : 'server-outline';
}

export function getServerSelectionTargetSubtitle(target: ServerSelectionTarget): string {
    if (target.kind === 'group') {
        const count = target.serverIds.length;
        return `${count} server${count === 1 ? '' : 's'}`;
    }
    return toServerUrlDisplay(target.serverUrl);
}
