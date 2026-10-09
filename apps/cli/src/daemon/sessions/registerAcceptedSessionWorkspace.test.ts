import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectAccountRowMutationRequestV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { mutateProjectAccountOrganization } from '@/workspaces/projectAccountRows';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createScmBackendRegistry } from '@/scm/registry';
import { createScmHostingProviderRegistry } from '@/scm/hostingProviders/registry';
import { inspectWorkspaceLocationWithScmWorkspace } from '@/scm/workspace/workspaceLocationInspection';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { createScmHostingProviderRuntimeServicesForTest, runWithRealGitScmRuntime } from '../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import { githubHostingProviderAdapter, GITHUB_SCM_HOSTING_PROVIDER_LOCAL_ID } from '../../../../../packages/plugins/scm-github/src/adapter';
import { GITHUB_PLUGIN_ID } from '../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import { createAcceptedSessionWorkspaceRegistration } from './registerAcceptedSessionWorkspace';

const execFileAsync = promisify(execFile);
afterEach(() => vi.restoreAllMocks());

describe('accepted Session workspace registration', () => {
  it('registers true SCM roots and joins only a unique proven hosting anchor without resurrecting Hide', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'happier-accepted-workspace-'));
    const root = await realpath(scratch);
    const directory = join(root, 'packages', 'app');
    await mkdir(directory, { recursive: true });
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: root });
    await execFileAsync('git', ['remote', 'add', 'origin', 'https://github.com/Owner/Repository.git'], { cwd: root });
    const other = { id: 'other-home-ref', serverId: 'home-b', machineId: 'machine-a', rootPath: root, createdAtMs: 1 };
    const otherKey = { kind: 'workspace-ref' as const, serverId: 'home-b', id: other.id };
    const organizationKey = { kind: 'project-organization' as const, serverId: 'home-a', projectKey: 'hidden-project' };
    const organization: ProjectAccountRowV1 = { key: organizationKey, revision: 2, content: { t: 'plain', v: { key: organizationKey, value: { hidden: true, pinned: true } } } };
    const rows: ProjectAccountRowV1[] = [{ key: otherKey, revision: 0, content: { t: 'plain', v: { key: otherKey, value: other } } }, organization];
    let ownerProjection: 'owner' | 'recipient' | 'missing' = 'owner';
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      const session = createSessionRecordFixture({ id: 'accepted-session', encryptionMode: 'plain',
        ...(ownerProjection === 'owner' ? { share: null } : ownerProjection === 'recipient' ? {
          share: { accessLevel: 'edit', canApprovePermissions: false },
        } : {}),
      });
      return { status: 200, data: { session } };
    });
    const requests: ReturnType<typeof ProjectAccountRowMutationRequestV1Schema.parse>[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
      const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
      requests.push(request);
      const acknowledged: ProjectAccountRowV1[] = [];
      for (const mutation of request.mutations) {
        const index = rows.findIndex(row => JSON.stringify(row.key) === JSON.stringify(mutation.key));
        const row = { key: mutation.key, revision: mutation.expectedRevision === 'absent' ? 0 : mutation.expectedRevision + 1, content: mutation.content };
        if (index < 0) rows.push(row); else rows[index] = row;
        acknowledged.push(row);
      }
      // The canonical mutate response acknowledges only this batch, never the whole list census.
      return { status: 200, data: { status: 'updated', rows: acknowledged, cursor: 1 } };
    });
    const registration = createGitScmBackendRuntimeRegistration();
    if (!registration.runtime) throw new Error('Git SCM test runtime is unavailable');
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
      executableDefinition: registration.runtime, registration,
    })]);
    const hostingProviderRuntimeServices = createScmHostingProviderRuntimeServicesForTest(createScmHostingProviderRegistry({
      providers: [{ id: GITHUB_SCM_HOSTING_PROVIDER_LOCAL_ID, pluginId: GITHUB_PLUGIN_ID, kind: 'github', displayName: 'GitHub', capabilities: [] }],
      runtimeRegistrations: [{ pluginId: GITHUB_PLUGIN_ID, occurrenceId: 'test-generation',
        registration: { id: GITHUB_SCM_HOSTING_PROVIDER_LOCAL_ID, adapter: { routing: githubHostingProviderAdapter } } }],
    }));
    const inspectLocation: typeof inspectWorkspaceLocationWithScmWorkspace = input => runWithRealGitScmRuntime(
      () => inspectWorkspaceLocationWithScmWorkspace({ ...input, registry }), { hostingProviderRuntimeServices },
    );
    const register = createAcceptedSessionWorkspaceRegistration({
      credentials: { token: 'project-token', encryption: null }, serverId: 'home-a', machineId: 'machine-a',
      inspectLocation,
    });
    const metadata = createTestMetadata({ path: directory });
    try {
      ownerProjection = 'recipient';
      await expect(register(metadata, 'accepted-session')).rejects.toMatchObject({ code: 'workspace_registration_requester_channel_unavailable' });
      ownerProjection = 'missing';
      await expect(register(metadata, 'accepted-session')).rejects.toMatchObject({ code: 'workspace_registration_owner_unavailable' });
      expect(requests).toHaveLength(0);
      ownerProjection = 'owner';
      await register({ ...metadata, sessionDirectoryV1: { v: 1, kind: 'managed' } }, 'accepted-session');
      expect(requests).toHaveLength(0);
      await register(metadata, 'accepted-session');
      const accepted = rows.flatMap(row => row.content?.t === 'plain' && row.content.v.key.kind === 'workspace-ref'
        && 'id' in row.content.v.value && row.content.v.value.serverId === 'home-a' ? [row.content.v.value] : []);
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({ rootPath: root, serverId: 'home-a', machineId: 'machine-a' });
      expect(accepted[0]?.repositoryIdentity).toEqual({ kind: 'github', deployment: 'https://github.com', repository: 'owner/repository' });
      expect(projectWorkspaceRefV1(accepted[0]!)).toEqual({ serverId: 'home-a', projectKey: accepted[0]!.id });
      expect(metadata.path).toBe(directory);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.topologyChange).toBe(true);
      const project = projectWorkspaceRefV1(accepted[0]!);
      await mutateProjectAccountOrganization({
        credentials: { token: 'project-token', encryption: null }, ...project,
        mutate: value => ({ ...value, hidden: true, pinned: true }),
      });
      const acceptedOrganization = rows.find(row => row.key.kind === 'project-organization'
        && row.key.serverId === project.serverId && row.key.projectKey === project.projectKey);
      expect(acceptedOrganization?.content).toEqual({ t: 'plain', v: {
        key: { kind: 'project-organization', ...project }, value: { hidden: true, pinned: true },
      } });
      await register(metadata, 'accepted-session');
      expect(requests).toHaveLength(2);
      expect(rows.find(row => row.key.kind === 'project-organization'
        && row.key.serverId === project.serverId && row.key.projectKey === project.projectKey))
        .toEqual(acceptedOrganization);
      expect(rows.find(row => row.key.kind === 'project-organization' && row.key.projectKey === 'hidden-project')).toEqual(organization);
      expect(rows.find(row => row.key.kind === 'workspace-ref' && row.key.serverId === 'home-b')?.content)
        .toEqual({ t: 'plain', v: { key: otherKey, value: other } });
      await register(createTestMetadata({ path: tmpdir() }), 'accepted-session');
      expect(requests).toHaveLength(2);

      const registerElsewhere = createAcceptedSessionWorkspaceRegistration({
        credentials: { token: 'project-token', encryption: null }, serverId: 'home-a', machineId: 'machine-b', inspectLocation,
      });
      const checkout = async (name: string, remote?: string) => {
        const checkoutRoot = join(root, name);
        await mkdir(join(checkoutRoot, 'nested'), { recursive: true });
        await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: checkoutRoot });
        if (remote) await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: checkoutRoot });
        return checkoutRoot;
      };
      const refAt = (checkoutRoot: string) => rows.flatMap(row => row.content?.t === 'plain'
        && row.content.v.key.kind === 'workspace-ref' && 'id' in row.content.v.value
        && row.content.v.value.serverId === 'home-a' && row.content.v.value.rootPath === checkoutRoot ? [row.content.v.value] : [])[0];
      const secondRoot = await checkout('second', 'git@github.com:owner/repository.git');
      await registerElsewhere(createTestMetadata({ path: join(secondRoot, 'nested') }), 'accepted-session');
      expect(refAt(secondRoot)).toMatchObject({ machineId: 'machine-b', rootPath: secondRoot, projectKey: project.projectKey,
        repositoryIdentity: accepted[0]?.repositoryIdentity });
      expect(rows.find(row => row.key.kind === 'project-organization'
        && row.key.serverId === project.serverId && row.key.projectKey === project.projectKey)).toEqual(acceptedOrganization);

      const unknownRoot = await checkout('unknown');
      await registerElsewhere(createTestMetadata({ path: unknownRoot }), 'accepted-session');
      const unknown = refAt(unknownRoot)!;
      expect(unknown.projectKey).toBe(unknown.id);
      expect(unknown.projectKey).not.toBe(project.projectKey);
      expect(unknown.repositoryIdentity).toBeUndefined();
      await execFileAsync('git', ['remote', 'add', 'origin', 'https://github.com/owner/repository.git'], { cwd: unknownRoot });
      await registerElsewhere(createTestMetadata({ path: unknownRoot }), 'accepted-session');
      expect(refAt(unknownRoot)).toMatchObject({ projectKey: unknown.id, repositoryIdentity: accepted[0]?.repositoryIdentity });
      const ambiguousRoot = await checkout('ambiguous', 'https://github.com/owner/repository.git');
      const beforeAmbiguous = requests.length;
      await registerElsewhere(createTestMetadata({ path: ambiguousRoot }), 'accepted-session');
      const independent = refAt(ambiguousRoot)!;
      expect(independent).toMatchObject({ machineId: 'machine-b', rootPath: ambiguousRoot,
        projectKey: independent.id, repositoryIdentity: accepted[0]?.repositoryIdentity });
      expect(independent.projectKey).not.toBe(project.projectKey);
      expect(independent.projectKey).not.toBe(unknown.projectKey);
      expect(refAt(secondRoot)?.projectKey).toBe(project.projectKey);
      expect(refAt(unknownRoot)?.projectKey).toBe(unknown.projectKey);
      expect(rows.find(row => row.key.kind === 'project-organization'
        && row.key.serverId === project.serverId && row.key.projectKey === project.projectKey)).toEqual(acceptedOrganization);
      expect(rows.find(row => row.key.kind === 'project-organization' && row.key.projectKey === 'hidden-project')).toEqual(organization);
      expect(requests).toHaveLength(beforeAmbiguous + 1);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
