import { describe, expect, it } from 'vitest';
import { projectEnvironmentSecretBindingRequiredUsesV1 } from './projectEnvironmentSecretBindingRequiredUsesV1.js';

describe('current Environment secret requirements', () => {
    const runtime = { machineId: 'runtime', installationId: 'runtime-current' };
    const builder = { machineId: 'builder', installationId: 'builder-current' };
    it('keeps build-only and runtime requirements separate and emits only installed subjects', () => {
        const result = projectEnvironmentSecretBindingRequiredUsesV1({ runtimeInstallations: [runtime], buildInstallation: builder,
            referencedSavedSecretRevisions: [
                { resourceId: 'build-secret', revision: 2, requiredBindings: [{ purpose: 'variable', phase: 'build' }], oldExtra: 'ignored' },
                { resourceId: 'runtime-secret', revision: 3, requiredBindings: [{ purpose: 'variable', phase: 'runtime' }] },
            ] });
        expect(result).toEqual({ status: 'complete', requiredSecretUses: [
            { resourceId: 'build-secret', resourceRevision: 2, ...builder },
            { resourceId: 'runtime-secret', resourceRevision: 3, ...runtime },
        ] });
    });
    it('requires live registry relation facts and retains the existing runtime plus builder destinations', () => {
        const input = { runtimeInstallations: [runtime], buildInstallation: builder,
            referencedSavedSecretRevisions: [{ resourceId: 'registry-secret', revision: 1,
                requiredBindings: [{ purpose: 'registry', targetLinkId: 'registry', access: 'pull' }] }] };
        expect(projectEnvironmentSecretBindingRequiredUsesV1(input).status).toBe('incomplete');
        expect(projectEnvironmentSecretBindingRequiredUsesV1({ ...input, currentRegistryTargetLinkIds: ['other'] }).status).toBe('incomplete');
        expect(projectEnvironmentSecretBindingRequiredUsesV1({ ...input, buildInstallation: null,
            currentRegistryTargetLinkIds: ['registry'] }).status).toBe('incomplete');
        expect(projectEnvironmentSecretBindingRequiredUsesV1({ ...input, currentRegistryTargetLinkIds: ['registry'] })).toEqual({
            status: 'complete', requiredSecretUses: [
                { resourceId: 'registry-secret', resourceRevision: 1, ...builder },
                { resourceId: 'registry-secret', resourceRevision: 1, ...runtime },
            ],
        });
        expect(projectEnvironmentSecretBindingRequiredUsesV1({ ...input, runtimeInstallations: [],
            currentRegistryTargetLinkIds: ['registry'] })).toEqual({ status: 'complete', requiredSecretUses: [
            { resourceId: 'registry-secret', resourceRevision: 1, ...builder },
        ] });
    });
    it('marks legacy, unavailable placement and every operational summary incomplete', () => {
        const project = (requiredBindings?: unknown) => projectEnvironmentSecretBindingRequiredUsesV1({ runtimeInstallations: [runtime],
            referencedSavedSecretRevisions: [{ resourceId: 'secret', revision: 1,
                ...(requiredBindings ? { requiredBindings } : {}) }] });
        expect(project()).toEqual({ status: 'incomplete', requiredSecretUses: [] });
        for (const purpose of ['backupDestination', 'domainCredential', 'dataRole']) {
            expect(project([{ purpose }])).toEqual({ status: 'incomplete', requiredSecretUses: [] });
        }
        expect(project([{ purpose: 'variable', phase: 'build' }]).status).toBe('incomplete');
        expect(projectEnvironmentSecretBindingRequiredUsesV1({ runtimeInstallations: null, buildInstallation: builder,
            referencedSavedSecretRevisions: [{ resourceId: 'secret', revision: 1,
                requiredBindings: [{ purpose: 'variable', phase: 'build' }] }] })).toEqual({ status: 'complete',
            requiredSecretUses: [{ resourceId: 'secret', resourceRevision: 1, ...builder }] });
        expect(projectEnvironmentSecretBindingRequiredUsesV1({ runtimeInstallations: null,
            referencedSavedSecretRevisions: [{ resourceId: 'secret', revision: 1,
                requiredBindings: [{ purpose: 'variable', phase: 'runtime' }] }] }).status).toBe('incomplete');
        expect(project([{ purpose: 'variable', phase: 'runtime', name: 'PRIVATE_NAME' }])).toEqual({
            status: 'incomplete', requiredSecretUses: [],
        });
    });
    it('deduplicates shared runtime/build subjects without mistaking partial facts for completeness', () => {
        expect(projectEnvironmentSecretBindingRequiredUsesV1({ runtimeInstallations: [runtime], buildInstallation: runtime,
            referencedSavedSecretRevisions: [{ resourceId: 'secret', revision: 1, requiredBindings: [
                { purpose: 'variable', phase: 'build' }, { purpose: 'variable', phase: 'runtime' }, { purpose: 'dataRole' },
            ] }] })).toEqual({ status: 'incomplete', requiredSecretUses: [{ resourceId: 'secret', resourceRevision: 1, ...runtime }] });
    });
});
