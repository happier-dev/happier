import { describe, expect, it } from 'vitest';
import { unwrapActionResultForRpc } from './registerActionSpecRpcHandlers';

describe('Project setup consent across the canonical Action RPC boundary', () => {
    it('retains only the validated current setup review needed by the original held invocation', () => {
        const failure = {
            ok: false as const,
            errorCode: 'project_setup_consent_required',
            error: 'project_setup_consent_required',
            details: {
                kind: 'pendingApproval', code: 'project_setup_consent_required',
                reviewedEffectDigest: 'current-effect', reviewedEffect: { purpose: 'setup', files: [] },
            },
        };
        expect(unwrapActionResultForRpc('projects.prepare', failure)).toEqual(failure);
        expect(unwrapActionResultForRpc('projects.script.run', failure)).toEqual(failure);
        const changed = { ...failure, errorCode: 'project_setup_effect_changed', error: 'project_setup_effect_changed',
            details: { ...failure.details, code: 'project_setup_effect_changed' } };
        expect(unwrapActionResultForRpc('projects.compute.exec', changed)).toEqual(changed);
        expect(unwrapActionResultForRpc('projects.prepare', {
            ...failure, details: { ...failure.details, secret: 'must-not-cross-the-boundary' },
        })).not.toHaveProperty('details');
        expect(unwrapActionResultForRpc('projects.prepare', {
            ...failure, details: { ...failure.details, code: 'project_setup_effect_changed' },
        })).not.toHaveProperty('details');
        expect(unwrapActionResultForRpc('memory.search', failure)).not.toHaveProperty('details');
    });
});
