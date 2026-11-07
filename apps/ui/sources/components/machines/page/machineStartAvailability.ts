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
 * Whether Start session is the page's filled primary. It leads only the Overview of an online Machine with nothing that
 * needs the person first; every other tab's own review or form leads its page, so the header steps back (one primary per
 * view).
 */
export function machineStartSessionDisplay(input: Readonly<{ tab: MachinePageTabId; online: boolean; needsYou: boolean }>): 'primary' | 'secondary' {
    return input.tab === 'overview' && input.online && !input.needsYou ? 'primary' : 'secondary';
}
