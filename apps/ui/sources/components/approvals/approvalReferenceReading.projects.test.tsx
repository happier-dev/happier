import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { ProjectOrganizationRow } from '@/sync/domains/workspaces/projectAccountRows';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { computeWorkspaceSyncPolicyDigest, WorkspaceSyncRelationshipV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { storage } = await import('@/sync/domains/state/storage');
const { useApprovalReferenceReading } = await import('./approvalReferenceReading');

describe('approval Project and Workspace label demand', () => {
    beforeEach(async () => {
        standardCleanup();
        await homes.reset();
    });
    afterEach(() => standardCleanup());

    async function arrange() {
        const home = await homes.addHome({ name: 'Projects Home', serverUrl: 'https://project-reference.test',
            accountId: 'alice', serverIdentityId: 'srv_projects' });
        await homes.selectHomes([home]);
        const scope = { serverId: 'srv_projects', accountId: 'alice' };
        const labelReads = { project: 0, workspace: 0 };
        const refs: WorkspaceRefV1[] = Array.from({ length: 1_000 }, (_, index) => ({
            id: `checkout-${index}`, serverId: scope.serverId, machineId: 'machine',
            projectKey: `project-${index}`, rootPath: `/repo-${index}`, createdAtMs: 1,
            get label() { if (index === 0) labelReads.workspace += 1; return `Folder ${index}`; },
        }));
        const organizations: ProjectOrganizationRow[] = refs.map((ref, index) => ({
            key: { kind: 'project-organization', serverId: scope.serverId, projectKey: ref.projectKey! },
            revision: 1, value: { get label() { if (index === 0) labelReads.project += 1; return `Project ${index}`; } },
        }));
        storage.setState({ profileScope: scope, settingsScope: scope,
            projectAccountRows: createProjectAccountRowsFixture(scope, { workspaceRefs: refs, organizations }) });
        return { home, scope, labelReads };
    }

    it('does zero unrelated label renders across Project and Workspace arrivals for another reference kind', async () => {
        const { home } = await arrange();
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useApprovalReferenceReading({ kind: 'agent', id: 'codex' }, 'codex', home);
        });
        const initial = hook.getCurrent();
        const before = renders;
        for (let index = 0; index < 5; index += 1) {
            await act(async () => storage.setState(state => {
                const rows = state.projectAccountRows!;
                return { projectAccountRows: { ...rows,
                    workspaceRefs: [...rows.workspaceRefs, { ...rows.workspaceRefs[0]!, id: `new-${index}` }],
                    organizations: [...rows.organizations, { ...rows.organizations[0]!,
                        key: { ...rows.organizations[0]!.key, projectKey: `new-${index}` } }],
                } };
            }));
        }
        expect(renders - before).toBe(0);
        expect(hook.getCurrent()).toEqual(initial);
    });

    it.each(['project', 'workspace'] as const)('reads only its selected %s, keeps real updates, and retires with its Account', async kind => {
        const { home, scope, labelReads } = await arrange();
        const id = kind === 'project' ? 'project-0' : 'checkout-0';
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useApprovalReferenceReading({ kind, id }, id, home);
        });
        expect(hook.getCurrent()).toMatchObject({ text: kind === 'project' ? 'Project 0' : 'Folder 0', named: true });
        const before = renders;
        labelReads.project = 0;
        labelReads.workspace = 0;
        for (let index = 1; index <= 5; index += 1) {
            await act(async () => storage.setState(state => {
                const rows = state.projectAccountRows!;
                return { projectAccountRows: { ...rows,
                    workspaceRefs: rows.workspaceRefs.map((ref, position) => position === index ? { ...ref, label: 'Changed sibling' } : ref),
                    organizations: rows.organizations.map((row, position) => position === index ? { ...row, value: { label: 'Changed sibling' } } : row),
                } };
            }));
        }
        expect(renders - before).toBe(0);
        expect(labelReads).toEqual({ project: 0, workspace: 0 });
        await act(async () => storage.setState(state => {
            const rows = state.projectAccountRows!;
            return { projectAccountRows: { ...rows,
                workspaceRefs: rows.workspaceRefs.map((ref, index) => index === 0 ? { ...ref, label: 'Renamed folder' } : ref),
                organizations: rows.organizations.map((row, index) => index === 0 ? { ...row, value: { label: 'Renamed project' } } : row),
            } };
        }));
        expect(hook.getCurrent()).toMatchObject({ text: kind === 'project' ? 'Renamed project' : 'Renamed folder', named: true });
        if (kind === 'workspace') {
            await act(async () => storage.setState(state => ({ projectAccountRows: { ...state.projectAccountRows!,
                workspaceRefs: [...state.projectAccountRows!.workspaceRefs, { ...state.projectAccountRows!.workspaceRefs[0]!, rootPath: '/ambiguous' }],
            } })));
            expect(hook.getCurrent()).toMatchObject({ text: id, named: false });
        }
        await act(async () => storage.setState({ profileScope: { ...scope, accountId: 'bob' } }));
        expect(hook.getCurrent()).toMatchObject({ text: id, named: false });
    });

    it('names only the demanded Sync link endpoints, follows their changes, and settles removal', async () => {
        const { home } = await arrange();
        const policy = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
        const link = WorkspaceSyncRelationshipV1Schema.parse({ v: 1, relationshipId: 'selected-link',
            controllerMachineId: 'machine', alphaWorkspaceRefId: 'checkout-0', betaWorkspaceRefId: 'checkout-1',
            mode: 'keep_synced', contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
            enabled: true, createdAtMs: 1, updatedAtMs: 1 });
        await act(async () => storage.setState(state => ({ projectAccountRows: { ...state.projectAccountRows!,
            relationships: [link, ...Array.from({ length: 1_000 }, (_, index) => ({ ...link, relationshipId: `sibling-link-${index}` }))],
        } })));
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useApprovalReferenceReading({ kind: 'workspaceSyncRelationship', id: link.relationshipId }, link.relationshipId, home);
        });
        expect(hook.getCurrent()).toMatchObject({ named: true });
        expect(hook.getCurrent().text).toContain('Folder 0');
        expect(hook.getCurrent().text).toContain('Folder 1');
        const before = renders;
        await act(async () => storage.setState(state => {
            const rows = state.projectAccountRows!;
            return { projectAccountRows: { ...rows,
                relationships: rows.relationships.map((row, index) => index > 0 ? { ...row, updatedAtMs: 2 } : row),
                workspaceRefs: rows.workspaceRefs.map((row, index) => index > 1 ? { ...row, label: 'Sibling' } : row),
            } };
        }));
        expect(renders - before).toBe(0);
        await act(async () => storage.setState(state => ({ projectAccountRows: { ...state.projectAccountRows!,
            workspaceRefs: state.projectAccountRows!.workspaceRefs.map((ref, index) => index === 0 ? { ...ref, label: 'Renamed endpoint' } : ref),
        } })));
        expect(hook.getCurrent().text).toContain('Renamed endpoint');
        await act(async () => storage.setState(state => ({ projectAccountRows: { ...state.projectAccountRows!, relationships: [] } })));
        expect(hook.getCurrent()).toMatchObject({ text: 'approvals.linkRemoved', named: true });
        await act(async () => storage.setState(state => ({ projectAccountRows: { ...state.projectAccountRows!, coverage: 'partial' } })));
        expect(hook.getCurrent()).toMatchObject({ resolving: true });
    });
});
