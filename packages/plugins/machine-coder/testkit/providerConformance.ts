import type { ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';
import { CoderLaunchSchema, ACCOUNT_SERVICE } from '../src/machine/schemas.js';
import { coderWorkspaceName } from '../src/machine/nativeClient.js';

/** Coder REST and `coder ssh` boundary for the shared provider conformance suite. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { state: s, guest, body, directory, managedId } = world;
    const foreignId = 'workspace-foreign';
    return {
        foreignId,
        launch: CoderLaunchSchema.parse({ organizationId: 'org', templateId: 'template', templateVersionId: 'version', agentName: 'main', parameterValues: [] }),
        account: { service: ACCOUNT_SERVICE, environment: { CODER_URL: 'https://coder.example.test', CODER_SESSION_TOKEN: world.privateBinding } },
        process(request, args) {
            if (args[0] === 'ssh') return guest(['sh', '-c', args.slice(args.indexOf('--') + 1).join(' ')], request.stdin);
            throw new Error(`Unexpected Coder command ${JSON.stringify(args)}`);
        },
        http(request, { path, method, isForeign, targetPresent }) {
            const build = () => ({ id: `build-${s.power}`, workspace_id: 'workspace', template_version_id: 'version',
                transition: s.power === 'stopped' ? 'stop' : 'start', status: s.power, job: { status: 'succeeded' },
                resources: [{ agents: [{ id: 'agent-main', name: 'main', status: 'connected', directory }] }] });
            const workspace = () => ({ id: isForeign ? foreignId : 'workspace', owner_id: 'user-a', owner_name: 'alice', organization_id: 'org', template_id: 'template',
                name: coderWorkspaceName(managedId), dormant_at: null, latest_build: build() });
            if (path === '/api/v2/users/me') return { value: { id: 'user-a', username: 'alice' } };
            if (path === '/api/v2/templateversions/version') return { value: { id: 'version', template_id: 'template', organization_id: 'org' } };
            if (path === '/api/v2/organizations/org/templates') return { value: [{ id: 'template', name: 'Template', organization_id: 'org', active_version_id: 'version' }] };
            if (path.endsWith('/rich-parameters')) return { value: [] };
            if (method === 'POST' && path.endsWith('/workspaces')) { s.allocations++; s.present = true; s.owned.add('workspace'); return { value: workspace(), status: 201 }; }
            if (method === 'POST' && path.endsWith('/builds')) {
                const transition = body(request).transition;
                if (transition === 'delete') world.remove(path.split('/').at(-2), 'workspace', () => { s.present = false; s.owned.delete('workspace'); });
                else s.power = transition === 'stop' ? 'stopped' : 'running';
                return { value: { ...build(), transition }, status: 201 };
            }
            if (path.startsWith('/api/v2/workspacebuilds/')) return { value: build() };
            return { status: targetPresent ? 200 : 404, value: workspace() };
        },
    };
};
