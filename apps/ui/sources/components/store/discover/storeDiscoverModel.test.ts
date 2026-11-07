import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { MarketplaceCatalogDiscoveryV1 } from '@happier-dev/protocol/marketplace';
import { findStoreDiscoverCategory, findStoreDiscoverJob, listStoreDiscoverJobs, projectStoreDiscover } from './storeDiscoverModel';
import { matchRegistryProjectSuggestions } from '@/registries/registryProjectSuggestions';
import { WorkspaceRefV1WriteSchema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { MarketplaceCatalogDiscoveryV1Schema, MarketplaceIndexSourceSnapshotV1Schema } from '@happier-dev/protocol/marketplace';

const mcp = (itemId: string) => ({ type: 'registryItem', kind: 'mcpServer', sourceId: 'builtin:mcp-registry', itemId }) as const;
const skill = (itemId: string) => ({ type: 'registryItem', kind: 'skill', sourceId: 'builtin:skills-sh', itemId }) as const;
const provider = (contributionKey: string) => ({ type: 'providerContribution', contributionKey }) as const;

function discovery(overrides: Partial<MarketplaceCatalogDiscoveryV1> = {}): MarketplaceCatalogDiscoveryV1 {
    return {
        items: [
            { id: 'playwright', reference: mcp('io.github.microsoft/playwright-mcp'), title: 'Playwright' },
            { id: 'webapp', reference: skill('anthropics/skills/webapp-testing'), title: 'webapp-testing' },
            { id: 'sentry-mcp', reference: mcp('io.github.getsentry/sentry-mcp'), title: 'Sentry' },
            { id: 'sentry-skill', reference: skill('getsentry/skills/sentry'), title: 'Sentry' },
            { id: 'ollama', reference: provider('happier.provider.ollama/ollama'), title: 'Ollama' },
        ],
        categories: [
            { id: 'browser', title: 'Browser testing', items: ['playwright', 'webapp'] },
            { id: 'errors', title: 'Error tracking', items: ['sentry-mcp', 'sentry-skill', 'playwright'] },
            { id: 'empty', title: 'Video tools', items: [] },
        ],
        jobs: [
            { id: 'browser', title: 'Give agents a real browser', description: 'A browser and a testing skill.', glyph: 'fcGlobe',
                groups: [{ title: 'Browser software', items: [] }, { title: 'Drive it', items: ['playwright'] }, { title: 'Test', items: ['webapp'] }] },
            { id: 'media', title: 'Record and edit video', description: 'Media tools.', glyph: 'fcPlayO', groups: [{ title: 'Record', items: [] }] },
        ],
        ...overrides,
    };
}

describe('projectStoreDiscover', () => {
    it('retains admitted native Software identity in featured, picks, job and category choices', () => {
        const reference = { type: 'software', value: { kind: 'toolchain', adapterId: 'mise', tool: 'python' } } as const;
        const input = MarketplaceCatalogDiscoveryV1Schema.parse({
            items: [{ id: 'python', title: 'Python', reference }],
            featured: { item: 'python', reason: 'Build with Python' },
            categories: [{ id: 'development', title: 'Development', items: ['python'] }],
            jobs: [{ id: 'develop', title: 'Develop', description: 'Set up development tools', glyph: 'fcCode',
                groups: [{ title: 'Runtime', items: ['python'] }] }],
        });
        const pages = [{ sourceId: 'curated', discovery: input }];
        expect(projectStoreDiscover(pages, []).featured?.item).toMatchObject({ kind: 'software', reference });
        expect(findStoreDiscoverJob(pages, 'develop')?.groups[0]?.items[0]?.reference).toEqual(reference);
        expect(findStoreDiscoverCategory(pages, 'development')?.items[0]?.reference).toEqual(reference);
        const picks = projectStoreDiscover([{ sourceId: 'curated', discovery: { ...input, featured: undefined, categories: [] } }], []);
        expect(picks.sections[0]?.items[0]?.reference).toEqual(reference);
    });
    it('shows copied editorial jobs once while retaining different choices under the same editorial id', () => {
        const pages = ['original', 'copy'].map(sourceId => ({ sourceId, discovery: discovery() }));
        for (const jobs of [listStoreDiscoverJobs(pages), projectStoreDiscover(pages, []).jobs]) {
            expect(jobs).toHaveLength(1);
            expect(jobs[0]?.sourceId).toBe('original');
            expect(findStoreDiscoverJob(pages, jobs[0]!.id, jobs[0]!.sourceId)?.ways).toBe(2);
        }
        const different = { sourceId: 'different', discovery: discovery({ items: [
            { id: 'playwright', reference: mcp('another-browser'), title: 'Another browser' },
        ] }) };
        expect(listStoreDiscoverJobs([...pages, different])).toHaveLength(2);
    });
    it('resolves duplicate editorial ids only in their qualified catalog and gives category sections distinct keys', () => {
        const pages = ['one', 'two'].map(sourceId => ({ sourceId, discovery: discovery({
            categories: [{ id: 'browser', title: sourceId, items: ['playwright'] }],
            jobs: [{ id: 'browser', title: sourceId, description: 'Browser', glyph: 'fcGlobe',
                groups: [{ title: 'Choices', items: ['playwright'] }] }],
            items: [{ id: 'playwright', title: sourceId, reference: mcp(sourceId) }],
        }) }));
        expect(findStoreDiscoverJob(pages, 'browser', 'two')?.title).toBe('two');
        expect(findStoreDiscoverCategory(pages, 'browser', 'two')?.title).toBe('two');
        expect(findStoreDiscoverJob(pages, 'browser', 'missing')).toBeNull();
        expect(findStoreDiscoverCategory(pages, 'browser', 'missing')).toBeNull();
        // An old unqualified link is usable only while it identifies one admitted choice.
        expect(findStoreDiscoverJob(pages, 'browser')).toBeNull();
        expect(findStoreDiscoverCategory(pages, 'browser')).toBeNull();
        expect(findStoreDiscoverJob(pages.slice(1), 'browser')?.sourceId).toBe('two');
        const sections = projectStoreDiscover(pages, []).sections.filter(section => section.categoryId !== null);
        expect(sections).toHaveLength(2);
        expect(new Set(sections.map(section => section.id)).size).toBe(2);
    });
    it('keeps the native supporting fact on the rendered suggestion and withdraws missing, false and retired facts', () => {
        const project = { serverId: 'home', projectKey: 'web' };
        const workspace = WorkspaceRefV1WriteSchema.parse({ id: 'checkout', ...project, machineId: 'machine', rootPath: '/web', createdAtMs: 1,
            repositoryIdentity: { kind: 'github', deployment: 'https://github.com', repository: 'team/web' } });
        const pages = [{ sourceId: 'curated', discovery: discovery({ suggestions: [{ item: 'webapp', because: { kind: 'repository', hostingKind: 'github' } }] }) }];
        const held = matchRegistryProjectSuggestions(pages, project, [workspace]);
        const page = projectStoreDiscover(pages, held);
        expect(page.suggestions).toHaveLength(1);
        expect(page.suggestions[0]?.because).toBe(held[0]?.because);
        expect(page.suggestions[0]?.because.workspace).toBe(workspace);
        for (const facts of [undefined, [], [{ ...workspace, repositoryIdentity: undefined }],
            [{ ...workspace, repositoryIdentity: { ...workspace.repositoryIdentity!, kind: 'gitlab' as const } }]]) {
            expect(projectStoreDiscover(pages, matchRegistryProjectSuggestions(pages, project, facts)).suggestions).toEqual([]);
        }
        expect(projectStoreDiscover(pages, matchRegistryProjectSuggestions(pages, null, [workspace])).suggestions).toEqual([]);
    });
    it('places each qualified item once, in Discover order, and keeps same-title items from different refs', () => {
        const page = projectStoreDiscover([{ sourceId: 'curated', discovery: discovery({ featured: { item: 'playwright', reason: 'Picked this week' } }) }], []);
        expect(page.featured?.item.title).toBe('Playwright');
        // The featured object is not repeated in a later actionable section.
        const placed = page.sections.flatMap(section => section.items.map(item => item.id));
        expect(placed).not.toContain('playwright');
        expect(new Set(placed).size).toBe(placed.length);
        // Two "Sentry" items with different refs both stay.
        expect(page.sections.find(section => section.categoryId === 'errors')?.items.map(item => item.id)).toEqual(['sentry-mcp', 'sentry-skill']);
        // Empty or fully deduped sections are absent.
        expect(page.sections.map(section => section.categoryId)).toEqual([null, 'browser', 'errors']);
        expect(page.sections[0]?.items.map(item => item.id)).toEqual(['ollama']);
    });

    it('offers a job only when it has an admitted choice, counting real ways and their kinds', () => {
        const page = projectStoreDiscover([{ sourceId: 'curated', discovery: discovery() }], []);
        expect(page.jobs.map(job => job.id)).toEqual(['browser']);
        expect(page.jobs[0]).toMatchObject({ ways: 2, kinds: ['mcpServer', 'skill'] });
        // A job's marks preview its choices; they never remove those items from the directory.
        expect(page.sections.flatMap(section => section.items.map(item => item.id))).toContain('playwright');
    });

    it('does not repeat a suggested item further down the page', () => {
        const curation = [{ sourceId: 'curated', discovery: discovery() }];
        const suggested = curation[0]!.discovery.items.find(item => item.id === 'webapp')!;
        const project = { serverId: 'home', projectKey: 'web' };
        const workspace = WorkspaceRefV1WriteSchema.parse({ id: 'checkout', ...project, machineId: 'machine', rootPath: '/web', createdAtMs: 1,
            repositoryIdentity: { kind: 'github', deployment: 'https://github.com', repository: 'team/web' } });
        const page = projectStoreDiscover(curation, [{ sourceId: 'curated', item: suggested, because: {
            kind: 'repository', project, workspace, repository: workspace.repositoryIdentity!,
        } }]);
        expect(page.suggestions.map(item => item.id)).toEqual(['webapp']);
        expect(page.sections.flatMap(section => section.items.map(item => item.id))).not.toContain('webapp');
    });

    it('retains admitted Apps and all six authored jobs from the generated catalog in the existing editorial slots', () => {
        const catalog = MarketplaceIndexSourceSnapshotV1Schema.parse(JSON.parse(readFileSync(
            new URL('../../../../../website/public/catalog.json', import.meta.url), 'utf8')));
        const input = catalog.discovery!;
        const pages = [{ sourceId: catalog.source.id, discovery: input }];
        const apps = input.items.filter(item => item.reference.type === 'registryItem' && item.reference.kind === 'app');
        const page = projectStoreDiscover(pages, []);
        const featured = input.items.find(item => item.id === input.featured?.item)!;
        expect(page.featured?.item).toMatchObject({ kind: 'app', reference: featured.reference });
        expect(page.jobs.map(job => job.id)).toEqual(input.jobs.map(job => job.id));
        expect(page.jobs).toHaveLength(6);
        for (const app of apps) {
            for (const job of input.jobs.filter(job => job.groups.some(group => group.items.includes(app.id)))) {
                expect(findStoreDiscoverJob(pages, job.id, catalog.source.id)?.groups.flatMap(group => group.items)
                    .find(item => item.id === app.id)?.reference).toEqual(app.reference);
            }
            for (const category of input.categories.filter(category => category.items.includes(app.id))) {
                expect(findStoreDiscoverCategory(pages, category.id, catalog.source.id)?.items
                    .find(item => item.id === app.id)?.reference).toEqual(app.reference);
            }
        }
        const picks = projectStoreDiscover([{ sourceId: catalog.source.id,
            discovery: { ...input, featured: undefined, categories: [] } }], []);
        expect(picks.sections[0]?.items.filter(item => item.kind === 'app').map(item => item.reference))
            .toEqual(apps.map(item => item.reference));
    });

    it('is empty when nothing is admitted', () => {
        const page = projectStoreDiscover([], []);
        expect(page).toMatchObject({ featured: null, suggestions: [], jobs: [], sections: [] });
    });
});
