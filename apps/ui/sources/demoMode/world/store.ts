import { MarketplaceCatalogDiscoveryV1Schema } from '@happier-dev/protocol/marketplace';
import type { RegistryCuration } from '@/registries/useRegistrySuggestions';

const settled = async () => {};

/** Representative catalog facts, never a claim that an external install ran. */
export function buildDemoStoreCuration(): RegistryCuration {
    const discovery = MarketplaceCatalogDiscoveryV1Schema.parse({
        items: [
            { id: 'playwright', title: 'Playwright', description: 'Let agents inspect pages, interact with your app, and test it in a real browser.',
                reference: { type: 'registryItem', kind: 'mcpServer', sourceId: 'builtin:mcp-registry', itemId: 'io.github.microsoft/playwright-mcp' } },
            { id: 'webapp-testing', title: 'Web app testing', description: 'Reusable guidance for checking web apps with Playwright.',
                reference: { type: 'registryItem', kind: 'skill', sourceId: 'builtin:skills-sh', itemId: 'anthropics/skills/webapp-testing' } },
            { id: 'github', title: 'GitHub', description: 'Bring issues, pull requests, and repository context into your sessions.',
                reference: { type: 'registryItem', kind: 'mcpServer', sourceId: 'builtin:mcp-registry', itemId: 'io.github.github/github-mcp-server' } },
            { id: 'sentry', title: 'Sentry', description: 'Investigate production errors with the context behind each issue.',
                reference: { type: 'registryItem', kind: 'mcpServer', sourceId: 'builtin:mcp-registry', itemId: 'io.github.getsentry/sentry-mcp' } },
            { id: 'openrouter', title: 'OpenRouter', description: 'Choose models from multiple providers through one connection.',
                reference: { type: 'providerContribution', contributionKey: 'happier.provider.openrouter/openrouter' } },
            { id: 'ollama', title: 'Ollama', description: 'Use local models on a machine you control.',
                reference: { type: 'providerContribution', contributionKey: 'happier.provider.ollama/ollama' } },
            { id: 'vercel', title: 'Vercel AI Gateway', description: 'Connect models through your Vercel AI Gateway.',
                reference: { type: 'providerContribution', contributionKey: 'happier.provider.vercel-ai-gateway/vercel-ai-gateway' } },
        ],
        featured: { item: 'playwright', reason: 'Give your agent a browser' },
        jobs: [
            { id: 'browser-testing', title: 'Test your web app', description: 'Browser tools and reusable testing guidance.', glyph: 'fcGlobe',
                groups: [{ title: 'Drive the browser', items: ['playwright'] }, { title: 'Guide the work', items: ['webapp-testing'] }] },
            { id: 'fix-production', title: 'Investigate an issue', description: 'Connect the error to the code and its review.', glyph: 'fcAlert',
                groups: [{ title: 'Understand the error', items: ['sentry'] }, { title: 'Follow the code', items: ['github'] }] },
            { id: 'choose-models', title: 'Choose your model', description: 'Local models, model providers, and gateways.', glyph: 'stAgent',
                groups: [{ title: 'Connect a model source', items: ['openrouter', 'ollama', 'vercel'] }] },
        ],
        categories: [
            { id: 'development', title: 'Build and review', items: ['github', 'sentry', 'webapp-testing'] },
            { id: 'models', title: 'Your choice of models', items: ['openrouter', 'ollama', 'vercel'] },
        ],
    });
    const layout: RegistryCuration['layout'] = {
        hasValue: true, loading: false, error: null, status: null, sourceFailures: [], refresh: settled,
    };
    return {
        items: [], pages: [], curation: [{ sourceId: 'demo-catalog', discovery }], sources: [],
        ...layout, layout, stale: false, sourceRevision: 'demo-catalog',
        hasNextPage: false, nextPage: settled,
    };
}
