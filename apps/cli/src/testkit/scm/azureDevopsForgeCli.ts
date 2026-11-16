import { createScmHostingProviderRegistry } from '@/scm/hostingProviders/registry';
import { createAzureDevopsOperationsAdapter } from '../../../../../packages/plugins/scm-azure-devops/src/operations/azureDevopsAdapter';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/scm-azure-devops/src/manifest';
import { createAzureDevopsCommandRuntime } from '../../../../../packages/plugins/scm-azure-devops/testkit/azureDevopsRuntime';

/** Native Azure CLI boundary with the real adapter and two configured organizations. */
export function createAzureDevopsForgeCliFixture(input: Readonly<{ cloneUrl: string }>) {
  const baseUrls = ['https://dev.azure.com/team-a', 'https://dev.azure.com/team-b'];
  const requests: string[][] = [];
  let repositoryCreated = false;
  const project = { id: '11111111-1111-4111-8111-111111111111', name: 'apps', state: 'wellFormed', visibility: 'private' };
  const commandRuntime = createAzureDevopsCommandRuntime(args => {
    if (args[0] === 'account') return { user: { name: 'dev@example.com' } };
    requests.push([...args]);
    const baseUrl = args[args.indexOf('--organization') + 1];
    if (!baseUrl || !baseUrls.includes(baseUrl)) throw new Error('Unexpected Azure fixture organization');
    if (args[0] === 'devops' && args[2] === 'list') return { continuationToken: null, value: [project] };
    if (args[0] === 'devops' && args[2] === 'show') return project;
    if (args[0] !== 'repos') throw new Error('Unexpected Azure fixture command');
    if (args[1] === 'create') repositoryCreated = true;
    if (!repositoryCreated) return new Error('The repository was not found');
    return { name: 'bakery', project, webUrl: input.cloneUrl, remoteUrl: input.cloneUrl, defaultBranch: 'refs/heads/main' };
  });
  const adapter = createAzureDevopsOperationsAdapter();
  const declaration = PLUGIN_MANIFEST.contributes.scmHostingProviders![0]!;
  const { title, ...definition } = declaration;
  const providerId = `${PLUGIN_MANIFEST.id}/${declaration.id}`;
  const hosting = createScmHostingProviderRegistry({ providers: [{ ...definition, pluginId: PLUGIN_MANIFEST.id,
    displayName: typeof title === 'string' ? title : title.fallback }], runtimeRegistrations: [{
    pluginId: PLUGIN_MANIFEST.id, occurrenceId: 'fixture', registration: { id: declaration.id,
      adapter: { routing: adapter, repositoryPublishing: adapter } },
  }], configuredDeploymentsByProviderId: new Map([[providerId, { bases: baseUrls, status: 'complete' }]]) });
  return { hosting, runtimeServices: { ...commandRuntime, resolveScmHostingProviderRegistry: async () => hosting },
    providerId, providerBaseUrl: baseUrls[1]!, nativeRequests: requests, repositoryCreated: () => repositoryCreated };
}
