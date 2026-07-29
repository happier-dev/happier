import { describe, expect, it } from 'vitest';

import { extractExecutionRunProfilesFromMachineCapabilitiesState } from './extractExecutionRunsBackendsFromMachineCapabilities';

describe('extractExecutionRunProfilesFromMachineCapabilitiesState', () => {
    it('accepts only qualified profiles with a committed generation', () => {
        const profiles = extractExecutionRunProfilesFromMachineCapabilitiesState({
            snapshot: { response: { results: { 'tool.executionRuns': { ok: true, data: {
                executionRunProfiles: [
                    {
                        id: 'review.coderabbit/review',
                        intent: 'review',
                        title: { key: 'profile.review', fallback: 'CodeRabbit Review' },
                        compatibleAgents: ['coderabbit'],
                        generationId: 'generation-3',
                        available: true,
                        defaults: { retention: 'resumable', runClass: 'bounded', io: 'streaming' },
                    },
                    { id: 'local-only', intent: 'review', generationId: 'generation-3' },
                    { id: 'review.deepsec/audit', intent: 'review' },
                ],
            } } } } },
        });

        expect(profiles).toEqual([{
            id: 'review.coderabbit/review',
            intent: 'review',
            title: 'CodeRabbit Review',
            compatibleAgentIds: ['coderabbit'],
            generationId: 'generation-3',
            available: true,
            defaults: { retention: 'resumable', runClass: 'bounded', io: 'streaming' },
        }]);
    });
});
