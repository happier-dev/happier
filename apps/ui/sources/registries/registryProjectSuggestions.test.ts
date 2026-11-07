import { expect, it } from 'vitest';
import { MarketplaceCatalogDiscoveryV1Schema } from '@happier-dev/protocol/marketplace';
import { WorkspaceRefV1WriteSchema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { matchRegistryProjectSuggestions } from './registryProjectSuggestions';

const project = { serverId: 'home', projectKey: 'project' };
const workspace = WorkspaceRefV1WriteSchema.parse({ id: 'checkout', serverId: project.serverId,
    projectKey: project.projectKey, machineId: 'machine', rootPath: 'C:\\projects\\web', label: 'Web', createdAtMs: 1,
    repositoryIdentity: { kind: 'github', deployment: 'https://github.com', repository: 'fixture/web' } });
const discovery = MarketplaceCatalogDiscoveryV1Schema.parse({ items: [{ id: 'review', title: 'Review', reference: {
    type: 'registryItem', kind: 'skill', sourceId: 'builtin:skills-sh', itemId: 'fixture/skills/review', version: 'pin',
} }], categories: [], jobs: [], suggestions: [{ item: 'review', because: { kind: 'repository', hostingKind: 'github' } }] });
const curation = [{ sourceId: 'catalog', discovery }];

it('explains an admitted suggestion with its actual held Project fact and withdraws with the fact or Project', () => {
    const matches = matchRegistryProjectSuggestions(curation, project, [workspace]);
    expect(matches).toEqual([{ sourceId: 'catalog', item: discovery.items[0], because: {
        kind: 'repository', project, workspace, repository: workspace.repositoryIdentity,
    } }]);
    expect(matches[0]!.because.workspace).toBe(workspace);
    expect(matchRegistryProjectSuggestions(curation, null, [workspace])).toEqual([]);
    expect(matchRegistryProjectSuggestions(curation, project, undefined)).toEqual([]);
    expect(matchRegistryProjectSuggestions(curation, project, [])).toEqual([]);
    expect(matchRegistryProjectSuggestions(curation, { ...project, serverId: 'other-home' }, [workspace])).toEqual([]);
    expect(matchRegistryProjectSuggestions(curation, { ...project, projectKey: 'other-project' }, [workspace])).toEqual([]);
    expect(matchRegistryProjectSuggestions(curation, project, [{ ...workspace, repositoryIdentity: undefined }])).toEqual([]);
    expect(matchRegistryProjectSuggestions([{ sourceId: 'catalog', discovery: { ...discovery, suggestions: undefined } }], project, [workspace])).toEqual([]);
    expect(matchRegistryProjectSuggestions([{ sourceId: 'catalog', discovery: { ...discovery,
        suggestions: [{ item: 'review', because: { kind: 'repository', hostingKind: 'gitlab' } }] } }], project, [workspace])).toEqual([]);
});

it('keeps authored placement and qualified native refs, without padding beyond the three Discover slots', () => {
    const first = discovery.items[0]!;
    const otherSource = { ...first, id: 'other-source', reference: { ...first.reference, type: 'registryItem' as const,
        kind: 'skill' as const, sourceId: 'other-source', itemId: 'fixture/skills/review', version: 'pin' } };
    const otherPin = { ...otherSource, id: 'other-pin', reference: { ...otherSource.reference, version: 'other-pin' } };
    const extra = { ...otherSource, id: 'extra', reference: { ...otherSource.reference, itemId: 'fixture/skills/extra' } };
    const choices = [first, { ...first, id: 'duplicate' }, otherSource, otherPin, extra];
    const page = MarketplaceCatalogDiscoveryV1Schema.parse({ ...discovery, items: choices,
        suggestions: choices.map(item => ({ item: item.id, because: { kind: 'repository', hostingKind: 'github' } })) });
    expect(matchRegistryProjectSuggestions([{ sourceId: 'catalog', discovery: page }], project, [workspace])
        .map(suggestion => suggestion.item.id)).toEqual(['review', 'other-source', 'other-pin']);
});
