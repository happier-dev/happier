import { describe, expect, it } from 'vitest';
import { ProjectPrepareInputV1Schema, readProjectSetupConsentFailureV1, readProjectSetupConsentHoldV1 } from './projectActionFamily.js';

describe('Project setup requested human consent scope', () => {
    const workspace = { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/project' };

    it('requires the existing reviewed effect digest when requesting either consent scope, without accepting authority input', () => {
        for (const consentScope of ['thisTime', 'untilChanged']) {
            const request = { workspace, phase: 'setup', expectedEffectDigest: 'reviewed', consentScope };
            expect(ProjectPrepareInputV1Schema.safeParse(request).success).toBe(true);
            expect(ProjectPrepareInputV1Schema.safeParse({ workspace, phase: 'setup', consentScope }).success).toBe(false);
            expect(ProjectPrepareInputV1Schema.safeParse({ ...request, authority: 'present_user' }).success).toBe(false);
        }
        expect(ProjectPrepareInputV1Schema.safeParse({ workspace, phase: 'setup' }).success).toBe(true);
        expect(ProjectPrepareInputV1Schema.safeParse({ workspace, phase: 'setup', expectedEffectDigest: 'reviewed', consentScope: 'forever' }).success).toBe(false);
    });

    it('retains requested scope only on strict no-effect D18 review and its minimal human hold projection', () => {
        for (const consentScope of ['thisTime', 'untilChanged']) {
            const details = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed',
                reviewedEffect: { commands: ['echo reviewed'] }, consentScope };
            const failure = { ok: false, errorCode: details.code, error: details.code, details };
            expect(readProjectSetupConsentFailureV1(failure)).toMatchObject({ details });
            expect(readProjectSetupConsentHoldV1('projects.prepare', failure)).toEqual({ kind: 'pendingApproval',
                code: details.code, reviewedEffectDigest: details.reviewedEffectDigest, consentScope });
            expect(readProjectSetupConsentFailureV1({ ...failure, details: { ...details, authority: 'present_user' } })).toBeNull();
            expect(readProjectSetupConsentHoldV1('projects.compute.exec', { ...failure, errorCode: 'project_script_effect_changed' })).toBeNull();
        }
    });
});
