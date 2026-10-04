import { describe, expect, it } from 'vitest';
import { buildScmDiffSummaryModelProfiles } from './models';

describe('Summary model catalog projection', () => {
    it('does not invent a supported runtime default when only an exact named model is offered', () => {
        const profiles = buildScmDiffSummaryModelProfiles({ backendTarget: { kind: 'backend', backendId: 'codex' },
            models: [{ id: 'offered', name: 'Offered' }], agentFormats: ['json'] });
        expect(profiles.map(profile => profile.modelSelector?.modelId)).toEqual(['offered']);
        expect(profiles[0]?.structuredOutput).toBe('supported');
    });
    it('keeps explicit unsupported truth, including actual offered default descriptors', () => {
        const profiles = buildScmDiffSummaryModelProfiles({ backendTarget: { kind: 'backend', backendId: 'codex' },
            models: [{ id: 'default', name: 'Actual default', capabilities: { structuredOutput: 'unsupported' } }],
            agentFormats: ['json'] });
        expect(profiles[0]).toMatchObject({ structuredOutput: 'unsupported' });
    });
});
