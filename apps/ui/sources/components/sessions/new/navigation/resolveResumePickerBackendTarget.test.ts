import { describe, expect, it } from 'vitest';

import { resolveResumePickerBackendTarget } from './resolveResumePickerBackendTarget';

describe('resolveResumePickerBackendTarget', () => {
    it('keeps precedence temp -> route -> settings while validating against available backend targets', () => {
        expect(resolveResumePickerBackendTarget({
            tempBackendTarget: { kind: 'backend', backendId: 'missing-review-bot', configuredBackendId: 'missing-review-bot' },
            routeBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            availableBackendTargets: [
                { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            ],
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'claude' },
        })).toEqual({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' });
    });
});
