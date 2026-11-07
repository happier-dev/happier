import type { MachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { t } from '@/text';

import type { MachinePageTabId } from './machinePageTabQuery';

/**
 * Why the Machine page's Start session is disabled, in words, from the canonical spawn readiness (MR6: a disabled
 * control names its reason at the control). Nothing while a start is possible or the Machine is still being read.
 */
export function describeMachineStartUnavailable(readiness: MachineSpawnReadiness, machine: string): string | undefined {
    switch (readiness.status) {
        case 'offline': return t('machineDetailPage.startUnavailable.offline', { machine });
        case 'keyUnavailable': return t('machineDetailPage.startUnavailable.locked', { machine });
        case 'rpcUnavailable': return t('machineDetailPage.startUnavailable.notAnswering', { machine });
        case 'revoked': return t('machineDetailPage.startUnavailable.removed', { machine });
        case 'replaced': return t('machineDetailPage.startUnavailable.replaced', { machine });
        case 'ready':
        case 'unknown':
        case 'missing':
            return undefined;
    }
}

/**
 * Which header action is the page's one filled primary. The header leads only on Overview: there the Machine's
 * needs-you action leads when it has one, else Start session on an online Machine. On every other tab the tab's own
 * review, staged change or form leads its page (Setup's and Network's "Review changes"), so both header actions step
 * back (one primary per view).
 */
export function machineHeaderPrimary(input: Readonly<{ tab: MachinePageTabId; online: boolean; needsYou: boolean }>): 'needsYou' | 'startSession' | null {
    if (input.tab !== 'overview') return null;
    if (input.needsYou) return 'needsYou';
    return input.online ? 'startSession' : null;
}
