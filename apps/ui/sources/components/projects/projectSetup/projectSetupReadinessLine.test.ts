import { describe, expect, it } from 'vitest';

import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { projectSetupReadinessLine } from './projectSetupReadinessLine';

describe('projectSetupReadinessLine', () => {
    it('says what the checkout’s setup producer reported, and nothing when setup is not needed or unreported', () => {
        const current = projectSetupReadinessLine({ kind: 'current', reviewedEffectDigest: 'd', completedAtMs: 1_700_000_000_000 });
        const unprepared = projectSetupReadinessLine({ kind: 'unprepared', reviewedEffectDigest: 'd' });
        const review = projectSetupReadinessLine({ kind: 'needsReview', code: 'setup_changed' });
        const unknown = projectSetupReadinessLine({ kind: 'unknown', code: 'machine_unreachable' });
        expect(current).toBe(t('projects.scripts.setup.readySince', { time: formatAsOfTime(1_700_000_000_000) }));
        expect(unprepared).toBe(t('projects.scripts.setup.notRunYet'));
        expect(review).toBe(t('projects.scripts.setup.needsReview'));
        expect(unknown).toBe(t('projects.scripts.setup.stateUnknown'));
        expect(projectSetupReadinessLine({ kind: 'notRequired', reviewedEffectDigest: 'd' })).toBeNull();
        expect(projectSetupReadinessLine(null)).toBeNull();
    });
});
