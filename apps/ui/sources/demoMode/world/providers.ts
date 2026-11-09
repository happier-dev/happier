import { projectAvailableProviderContributionsV1 } from '@happier-dev/protocol/providers/connections/sourceFactsV1';
import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';

/** Real bundled connector declarations, with no configured credential or runtime claim. */
export function buildDemoProviderContributions() {
    const displayed = new Set([
        'happier.provider.openrouter/openrouter',
        'happier.provider.ollama/ollama',
        'happier.provider.vercel-ai-gateway/vercel-ai-gateway',
    ]);
    return projectAvailableProviderContributionsV1({
        connections: [],
        definitions: readAccountProviderDeclarations({ kind: 'account' }).filter(declaration => displayed.has(declaration.contributionKey)),
    });
}
