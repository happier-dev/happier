import type { ProjectSetupReadinessV1 } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';

import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

/**
 * The checkout's setup state on return, as its setup-readiness producer reported it (the same fact the
 * Scripts page reads). A finished authoring Session is no evidence of setup; nothing is said when
 * setup is not needed or the producer reported nothing.
 */
export function projectSetupReadinessLine(
    readiness: ProjectSetupReadinessV1 | null,
    /** The selected native environment's name: its changed inputs ask for a new review (plan 24). */
    toolchainName: string | null = null,
): string | null {
    switch (readiness?.kind) {
        case 'current': return t('projects.scripts.setup.readySince', { time: formatAsOfTime(readiness.completedAtMs) });
        case 'unprepared': return t('projects.scripts.setup.notRunYet');
        case 'needsReview': return toolchainName ? t('projects.scripts.toolchain.changed') : t('projects.scripts.setup.needsReview');
        case 'unknown': return t('projects.scripts.setup.stateUnknown');
        default: return null;
    }
}
