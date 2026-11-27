import { afterEach, expect, it, vi } from 'vitest';
import { resolveProjectRequesterSecretBindings } from './projectSetupRequesterInputs';
import { LaunchSecretReferenceOverlayError } from '@/settings/secrets/secretReferenceOverlay';
import { mockProjectAccountRowsHttpBoundary } from '../projectAccountRows.testkit';

afterEach(() => vi.restoreAllMocks());

it('does not retain or acquire a reference after its Project requirement is removed', async () => {
    const post = mockProjectAccountRowsHttpBoundary([]);
    await expect(resolveProjectRequesterSecretBindings({ credentials: { token: 'fixture', encryption: null } }, {
        project: { serverId: 'home', projectId: 'project' }, requirements: [{ name: 'CURRENT_TOKEN', kind: 'secret', required: true }],
        environmentBindings: { v: 1, bindings: { REMOVED_TOKEN: { ref: 'personal:removed' } } },
    })).rejects.toMatchObject({ name: LaunchSecretReferenceOverlayError.name, reason: 'undeclared_requirement',
        code: 'project_environment_binding_unavailable', requirementName: 'REMOVED_TOKEN' });
    expect(post).not.toHaveBeenCalled();
});

it('selects the saved Project binding when a requirement omits its kind', async () => {
    const key = { kind: 'project-organization', serverId: 'home', projectKey: 'project' };
    const environmentBindings = { v: 1, bindings: { TOKEN: { ref: 'saved-token' } } };
    mockProjectAccountRowsHttpBoundary([{ key, revision: 1, content: { t: 'plain', v: { key, value: { environmentBindings } } } }]);
    await expect(resolveProjectRequesterSecretBindings({ credentials: { token: 'fixture', encryption: null } }, {
        project: { serverId: 'home', projectId: 'project' }, requirements: [{ name: 'TOKEN', required: true }],
    })).resolves.toEqual(environmentBindings);
});
