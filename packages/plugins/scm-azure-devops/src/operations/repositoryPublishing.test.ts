import type { HostingProviderRoutingCapability, HostingProviderRuntimeServices, ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';
import { describe, expect, it, vi } from 'vitest';

import { createAzureDevopsOperationsAdapter } from './azureDevopsAdapter.js';
import { createAzureDevopsCommandRuntime } from '../../testkit/azureDevopsRuntime.js';

const provider: ScmHostingProviderRef = {
  id: 'happier.scm.forge.azure-devops/azure-devops', kind: 'azure-devops',
  displayName: 'Azure DevOps', baseUrl: 'https://dev.azure.com/happier-dev',
};
const project = { id: '11111111-1111-4111-8111-111111111111', name: 'platform', state: 'wellFormed', visibility: 'private' };
const repository = {
  name: 'new-app', project, webUrl: 'https://dev.azure.com/happier-dev/platform/_git/new-app',
  remoteUrl: 'https://dev.azure.com/happier-dev/platform/_git/new-app',
  sshUrl: 'git@ssh.dev.azure.com:v3/happier-dev/platform/new-app', defaultBranch: 'refs/heads/main',
};

function commandBoundary(handle: (args: readonly string[]) => unknown): HostingProviderRuntimeServices {
  return createAzureDevopsCommandRuntime((args) => args[0] === 'account' ? { user: { name: 'dev@example.com' } } : handle(args));
}

describe('Azure repository publication before a checkout exists', () => {
  it('enumerates configured organization deployments without inventing repository coordinates', () => {
    const routing: HostingProviderRoutingCapability = createAzureDevopsOperationsAdapter();
    const deployments = routing.listDeployments?.({ connectedAccountBases: [
      provider.baseUrl, `${provider.baseUrl}/`, 'https://happier-dev.visualstudio.com',
      'http://dev.azure.com/happier-dev', 'https://user:password@dev.azure.com/happier-dev',
    ] });
    expect(deployments).toEqual([
      expect.objectContaining({ baseUrl: provider.baseUrl }),
      expect.objectContaining({ baseUrl: 'https://happier-dev.visualstudio.com' }),
    ]);
    expect(deployments?.every((deployment) => !deployment.nameWithOwner)).toBe(true);
  });

  it('discovers all project targets through native Azure CLI authentication without publication', async () => {
    const commands: string[][] = [];
    const runtimeServices = commandBoundary((args) => {
      commands.push([...args]);
      expect(args.slice(0, 3)).toEqual(['devops', 'project', 'list']);
      const continuation = args.includes('--continuation-token');
      return { continuationToken: continuation ? null : 'page-2', value: [{ ...project, ...(continuation ? {
        id: '22222222-2222-4222-8222-222222222222', name: 'public-apps', visibility: 'public',
      } : {}) }] };
    });
    const result = await createAzureDevopsOperationsAdapter().describePublishTargets({
      provider, defaultRepositoryName: 'new-app', runtimeServices,
    });
    expect(result.auth).toMatchObject({ state: 'authenticated', profileKind: 'provider_cli' });
    expect(result.targets).toMatchObject([
      { owner: 'happier-dev/platform', supportedVisibilities: ['private'] },
      { owner: 'happier-dev/public-apps', supportedVisibilities: ['public'] },
    ]);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain('page-2');
  });

  it('distinguishes an empty organization from unreadable project discovery', async () => {
    const adapter = createAzureDevopsOperationsAdapter();
    expect(await adapter.describePublishTargets({ provider, defaultRepositoryName: 'new-app',
      runtimeServices: commandBoundary(() => ({ continuationToken: null, value: [] })) })).toMatchObject({
      auth: { state: 'authenticated' }, targets: [],
    });
    await expect(adapter.describePublishTargets({ provider, defaultRepositoryName: 'new-app',
      runtimeServices: commandBoundary(() => ({})) })).rejects.toMatchObject({ errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED });
  });

  it('returns native sign-in remediation without trying project discovery when no repository exists', async () => {
    const executeCommand = vi.fn(async () => ({ ok: false, stdout: '', stderr: 'Run az login', exitCode: 1 }));
    expect(await createAzureDevopsOperationsAdapter().describePublishTargets({
      provider, defaultRepositoryName: 'new-app', runtimeServices: { executeCommand },
    })).toMatchObject({ auth: { state: 'authentication_required', remediation: { kind: 'auth_required' } }, targets: [] });
    expect(executeCommand).toHaveBeenCalledTimes(1);
  });

  it('creates and reads a repository in the selected project without a preexisting repository', async () => {
    const commands: string[][] = [];
    const runtimeServices = commandBoundary((args) => {
      commands.push([...args]);
      if (args[0] === 'devops') return project;
      return repository;
    });
    const adapter = createAzureDevopsOperationsAdapter();
    const input = { provider, owner: 'happier-dev/platform', repositoryName: 'new-app', runtimeServices };
    const created = await adapter.createRepository({ ...input, visibility: 'private' });
    expect(created).toMatchObject({ nameWithOwner: 'happier-dev/platform/new-app', cloneUrl: repository.remoteUrl,
      provider: { nameWithOwner: 'happier-dev/platform/new-app' }, defaultBranch: 'main', visibility: 'private' });
    expect(await adapter.getRepository(input)).toEqual(created);
    expect(commands).toEqual([
      ['devops', 'project', 'show', '--organization', provider.baseUrl, '--project', 'platform', '--output', 'json'],
      ['repos', 'create', '--organization', provider.baseUrl, '--project', 'platform', '--name', 'new-app', '--output', 'json'],
      ['repos', 'show', '--organization', provider.baseUrl, '--project', 'platform', '--repository', 'new-app', '--output', 'json'],
    ]);
  });

  it('refuses private publication into a public project before creation and accepts its actual visibility', async () => {
    const commands: string[][] = [];
    const runtimeServices = commandBoundary((args) => {
      commands.push([...args]);
      return args[0] === 'devops' ? { ...project, visibility: 'public' }
        : { ...repository, project: { ...project, visibility: 'public' } };
    });
    const adapter = createAzureDevopsOperationsAdapter();
    const input = { provider: { ...provider, nameWithOwner: 'happier-dev/platform/existing' },
      owner: 'happier-dev/platform', repositoryName: 'new-app', runtimeServices };
    await expect(adapter.createRepository({ ...input, visibility: 'private' })).rejects.toMatchObject({
      errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
    });
    expect(commands.map((args) => args.slice(0, 3))).toEqual([['devops', 'project', 'show']]);
    const created = await adapter.createRepository({ ...input, visibility: 'public' });
    expect(created.visibility).toBe('public');
    expect(commands.map((args) => args.slice(0, 3))).toEqual([
      ['devops', 'project', 'show'], ['devops', 'project', 'show'], ['repos', 'create', '--organization'],
    ]);
    expect((await adapter.getRepository(input))?.visibility).toBe('public');
  });

  it('keeps a missing repository distinct from authentication and interrupted reads', async () => {
    const failures = [new Error('The repository was not found'), new Error('authentication failed'), new Error('lost connection')];
    const runtimeServices = commandBoundary(() => failures.shift());
    const adapter = createAzureDevopsOperationsAdapter();
    const input = { provider, owner: 'happier-dev/platform', repositoryName: 'new-app', runtimeServices };
    expect(await adapter.getRepository(input)).toBeNull();
    await expect(adapter.getRepository(input)).rejects.toMatchObject({ errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED });
    await expect(adapter.getRepository(input)).rejects.toMatchObject({ errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED });
  });

  it('refuses a foreign organization before invoking Azure CLI', async () => {
    const runtimeServices = commandBoundary(() => repository);
    await expect(createAzureDevopsOperationsAdapter().createRepository({
      provider, owner: 'other/platform', repositoryName: 'new-app', visibility: 'private',
      runtimeServices,
    })).rejects.toMatchObject({ errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST });
    expect(runtimeServices.executeCommand).not.toHaveBeenCalled();
  });
});
