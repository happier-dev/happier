import { describe, expect, it, vi } from 'vitest';
import { buildScmDiffSummaryModelProfiles } from './models';
import * as targets from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

describe('Summary model catalog projection', () => {
    it('derives one target key for the model catalog and projects a changed target once', () => {
        const models = [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }, { id: 'third', name: 'Third' }];
        const keyWork = vi.spyOn(targets, 'buildBackendTargetKeyV2');
        try {
            const first = buildScmDiffSummaryModelProfiles({ backendTarget: { kind: 'backend', backendId: 'codex' }, models });
            expect.soft(keyWork.mock.calls.length).toBe(1);
            keyWork.mockClear();
            const changed = buildScmDiffSummaryModelProfiles({ backendTarget: { kind: 'backend', backendId: 'claude' }, models });
            expect.soft(keyWork.mock.calls.length).toBe(1);
            expect(new Set(first.map(profile => profile.modelSelector?.backendTargetKey))).toEqual(new Set(['agent:happier.agent.codex/codex']));
            expect(new Set(changed.map(profile => profile.modelSelector?.backendTargetKey))).toEqual(new Set(['agent:happier.agent.claude/claude']));
        } finally { keyWork.mockRestore(); }
    });
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
