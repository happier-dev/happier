import type { DatabaseDescriptorV1 } from '../../databaseOperations.js';

/** Fresh credential-free worktree descriptor for protocol and consumer contract tests. */
export function createDatabaseDescriptorV1Fixture(): DatabaseDescriptorV1 {
    return {
        target: { kind: 'worktree', accountId: 'account', installationId: 'installation', projectKey: 'project',
            workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' },
            source: { kind: 'service', serviceId: 'api', variable: 'DATABASE_URL' } },
        label: 'Database', engine: 'postgresql', origin: { label: 'api' },
        placement: { serverId: 'home', accountId: 'account', machineId: 'machine', installationId: 'installation' },
        capabilities: [],
    };
}
