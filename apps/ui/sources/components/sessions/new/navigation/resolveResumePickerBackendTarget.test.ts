import { describe, expect, it } from 'vitest';

import { resolveResumePickerBackendTarget } from './resolveResumePickerBackendTarget';

describe('resolveResumePickerBackendTarget', () => {
    it('keeps precedence temp -> route -> settings while validating against available backend targets', () => {
        expect(resolveResumePickerBackendTarget({
            tempBackendTarget: { kind: 'configuredAcpBackend', backendId: 'missing-review-bot' },
            routeBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            availableBackendTargets: [
                { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            ],
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        })).toEqual({ kind: 'configuredAcpBackend', backendId: 'review-bot' });
    });
});
