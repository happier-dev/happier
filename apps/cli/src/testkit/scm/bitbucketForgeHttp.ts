import { createScmHostingProviderRegistry } from '@/scm/hostingProviders/registry';
import { createBitbucketApiAdapter } from '../../../../../packages/plugins/scm-bitbucket/src/operations/bitbucketApiAdapter';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/scm-bitbucket/src/manifest';

/** Fake Forge HTTP and credential acquisition; use the real Bitbucket adapter and registry. */
export function createBitbucketForgeHttpFixture(input: Readonly<{ nameWithOwner: string; cloneUrl: string }>) {
  let repositoryCreated = false;
  const httpRequests: { method: string; path: string }[] = [];
  const adapter = createBitbucketApiAdapter({ fetcher: async (url, init) => {
    const path = new URL(url).pathname;
    httpRequests.push({ method: init?.method ?? 'GET', path });
    if (path === '/2.0/user/workspaces') {
      const body = { values: [{ workspace: { uuid: '{2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901}',
        slug: input.nameWithOwner.split('/')[0], name: 'Alice' }, administrator: true }] };
      return { ok: true, status: 200, statusText: 'Fixture', json: async () => body, text: async () => JSON.stringify(body) };
    }
    if (path !== `/2.0/repositories/${input.nameWithOwner}`) throw new Error(`Unexpected Forge fixture request: ${path}`);
    if (init?.method === 'POST') repositoryCreated = true;
    const body = repositoryCreated ? { full_name: input.nameWithOwner, is_private: true,
      links: { html: { href: `https://bitbucket.org/${input.nameWithOwner}` }, clone: [{ name: 'https', href: input.cloneUrl }] } }
      : { error: { message: 'Not found' } };
    return { ok: repositoryCreated, status: repositoryCreated ? 200 : 404, statusText: 'Fixture',
      json: async () => body, text: async () => JSON.stringify(body) };
  } });
  const declaration = PLUGIN_MANIFEST.contributes.scmHostingProviders![0]!;
  const { title, ...definition } = declaration;
  const hosting = createScmHostingProviderRegistry({ providers: [{ ...definition, pluginId: PLUGIN_MANIFEST.id,
    displayName: typeof title === 'string' ? title : title.fallback }], runtimeRegistrations: [{
    pluginId: PLUGIN_MANIFEST.id, occurrenceId: 'fixture', registration: { id: declaration.id,
      adapter: { routing: adapter, repositoryPublishing: adapter } },
  }] });
  const runtimeServices = { resolveScmHostingProviderRegistry: async () => hosting,
    resolveScmHostingBasicAuthMaterialization: async () => ({ kind: 'available' as const, username: 'alice', password: 'fixture', profileKey: 'bitbucket:fixture' }) };
  return { hosting, runtimeServices, httpRequests, repositoryCreated: () => repositoryCreated };
}
