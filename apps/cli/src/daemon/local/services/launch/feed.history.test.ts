import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { createLocalServiceInventoryRegistry } from '../inventory/registry';
import { createLocalServicePreviewRegistry } from '../preview/registry';
import { createLocalServiceLauncherFeed } from './feed';

// E02 build #153: available/stopped history, one current declaration and one missing
// exact target id. The saved feed omits custody fields; native Stop below settles them.
describe('retained Service declaration availability', () => {
    it('offers the current declaration Start and explains history without an exact current declaration', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'service-feed-history-'));
        const owner = createManagedServicesOwner({
            projectServiceStateDirectory: directory,
            processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            // Literal native launches do not acquire plugin dependencies.
            dependencies: Object.freeze({}) as never, resolveScope: scope => scope,
        });
        const workspace = { id: 'checkout', serverId: 'home', machineId: 'machine-a', rootPath: process.cwd(), createdAtMs: 1 };
        try {
            for (const name of ['copy-check-web', 'w18-web']) {
                const handle = await owner.superviseProject({ kind: 'workspace', workspace,
                    declaration: { workspaceRefId: workspace.id, selection: { kind: 'manifest', name } },
                    cwd: workspace.rootPath, serviceId: `project-service:${name}`, specIdentity: name, isCurrent: () => true,
                    requester: { serverId: 'home', accountId: 'owner', machineId: workspace.machineId, installationId: 'installation' },
                    execution: 'portable',
                    processSpec: { mode: { kind: 'managedSpawn', host: '127.0.0.1' } },
                    authorizeLaunch: async input => ({ command: process.execPath,
                        args: ['-e', `require('node:http').createServer((req,res)=>res.end('ok')).listen(${input.endpoint!.port},'127.0.0.1')`],
                        env: {}, release: async () => undefined }),
                });
                await handle.stop();
            }
            const feed = createLocalServiceLauncherFeed({ machineId: workspace.machineId, projectManagedServices: owner,
                inventoryRegistry: createLocalServiceInventoryRegistry(), previewRegistry: createLocalServicePreviewRegistry(),
                runTargets: () => ({ targets: [{ id: 'project-service:copy-check-web', cwd: workspace.rootPath,
                    workspaceId: workspace.id, workspace: { serverId: workspace.serverId, machineId: workspace.machineId,
                        workspaceId: workspace.id, rootPath: workspace.rootPath },
                    declaration: { workspaceRefId: workspace.id, selection: { kind: 'manifest', name: 'copy-check-web' } },
                    title: 'copy-check-web' }], worktreePortDefinitions: [] }),
            });
            const snapshot = LocalServiceLauncherSnapshotV1Schema.parse(await feed.getSnapshot());
            expect(snapshot.targets.find(target => target.id === 'project-service:copy-check-web'))
                .toMatchObject({ state: 'available', serviceState: 'stopped', actions: ['start'] });
            expect(snapshot.targets.find(target => target.id === 'project-service:w18-web'))
                .toMatchObject({ state: 'available', serviceState: 'stopped', actions: [],
                    unavailableReason: 'launcher_start_declaration_unavailable' });
        } finally { await owner.dispose(); await rm(directory, { recursive: true, force: true }); }
    });
});
