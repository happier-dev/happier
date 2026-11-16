import { expect, it } from 'vitest';
import { resolvePublishTargetRecommendation } from './resolvePublishTargetRecommendation.js';

it('offers only publish-capable forge pairs with a declared integration or a checkout upload route', () => {
    const targets = [
        { id: 'integrated', targetClass: 'platform', availability: 'available', accepts: ['static'], sources: { gitIntegration: ['github'], upload: false } },
        { id: 'upload', targetClass: 'platform', availability: 'available', accepts: ['static'], sources: { gitIntegration: [], upload: true } },
        { id: 'unknown', targetClass: 'platform', availability: 'available', accepts: ['static'] },
    ] as const;
    const input = { definition: null, deploy: { framework: 'html', output: 'static' }, targets,
        repositoryProviderKind: 'github', publishProviderKinds: ['github', 'bitbucket'], uploadAvailable: false } as const;
    expect(resolvePublishTargetRecommendation(input).offeredTargetIds).toEqual(['integrated']);
    expect(resolvePublishTargetRecommendation({ ...input, repositoryProviderKind: 'bitbucket', uploadAvailable: true }).compatibleTargetIds).toEqual(['upload']);
    expect(resolvePublishTargetRecommendation({ ...input, repositoryProviderKind: 'gitlab', uploadAvailable: true }).offeredTargetIds).toEqual([]);
    expect(resolvePublishTargetRecommendation({ ...input, repositoryProviderKind: 'bitbucket' }).compatibleTargetIds).toEqual([]);
});

it('uses all known publishing forges before the person chooses one, and keeps an empty registry unavailable', () => {
    const input = { definition: null, deploy: { framework: 'html', output: 'static' },
        targets: [{ id: 'gitlab-only', targetClass: 'platform', availability: 'available', accepts: ['static'],
            sources: { gitIntegration: ['gitlab'], upload: false } }],
        publishProviderKinds: ['github', 'gitlab'], uploadAvailable: false } as const;
    expect(resolvePublishTargetRecommendation(input).compatibleTargetIds).toEqual(['gitlab-only']);
    expect(resolvePublishTargetRecommendation({ ...input, publishProviderKinds: [] }).offeredTargetIds).toEqual([]);
});
