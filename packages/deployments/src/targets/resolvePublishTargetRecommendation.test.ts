import { describe, expect, it } from 'vitest';
import { resolvePublishTargetRecommendation } from './resolvePublishTargetRecommendation.js';

const server = { id: 'server', targetClass: 'ownServer', availability: 'available' } as const;
const platform = { id: 'platform', targetClass: 'platform', availability: 'available' } as const;

describe('Publish target recommendation from owner facts', () => {
    it('recommends stored Compose and images on an available own server without assuming platform source support', () => {
        for (const definition of [{ from: 'compose' }, { from: 'image' }, { kind: 'stored' }] as const) {
            expect(resolvePublishTargetRecommendation({ definition, targets: [platform, server] })).toMatchObject({
                target: { id: 'server', targetClass: 'ownServer' }, compatibleTargetIds: ['server'], offeredTargetIds: ['server'],
                evidence: ['stored_definition'], uncertainty: ['platform_source_capability_unknown'],
            });
        }
    });
    it('keeps an unavailable server as a compatible workload choice with a repair, without recommending it', () => {
        expect(resolvePublishTargetRecommendation({ definition: { kind: 'stored' },
            targets: [{ ...server, availability: 'unavailable' }] })).toMatchObject({
            target: null, compatibleTargetIds: ['server'], corrections: [{ targetId: 'server', kind: 'choose_machine' }],
        });
    });
    it('reports unknown repository shape and preparation instead of inventing a framework recommendation', () => {
        expect(resolvePublishTargetRecommendation({ definition: { kind: 'repository' }, targets: [platform, server] })).toMatchObject({
            target: null, compatibleTargetIds: ['server'], evidence: [],
            uncertainty: ['project_shape_unknown', 'platform_source_capability_unknown'],
            corrections: [{ targetId: 'server', kind: 'prepare_repository' }],
        });
    });
    it('keeps the linked target and its unavailable reason ahead of a compatible server recommendation', () => {
        const existing = { id: 'platform', targetClass: 'platform' } as const;
        expect(resolvePublishTargetRecommendation({ definition: { kind: 'stored' }, existingTarget: existing,
            targets: [{ ...platform, availability: 'unavailable' }, server] })).toMatchObject({
            target: existing, evidence: ['existing_target', 'stored_definition'],
            uncertainty: ['platform_source_capability_unknown'], corrections: [{ targetId: 'platform', kind: 'repair_target' }],
        });
    });
    it('preserves explicit intent even when that exact target disappears, without falling back', () => {
        const explicit = { id: 'chosen-machine', targetClass: 'ownServer' } as const;
        expect(resolvePublishTargetRecommendation({ definition: { kind: 'stored' }, explicitTarget: explicit,
            existingTarget: { id: 'platform', targetClass: 'platform' }, targets: [platform, server] })).toMatchObject({
            target: explicit, evidence: ['explicit_target', 'stored_definition'],
            corrections: expect.arrayContaining([{ targetId: 'chosen-machine', kind: 'choose_machine' }]),
        });
    });
});

// Static output is portable to static hosts; Workers require a worker program.
it('judges static starter output from declared target facts', () => {
    const targets = [
        { id: 'pages', targetClass: 'platform', availability: 'available', accepts: ['static'], needs: ['repository'] },
        { id: 'workers', targetClass: 'platform', availability: 'available', accepts: ['workers'], needs: ['stateless'] },
        { id: 'vercel', targetClass: 'platform', availability: 'available', accepts: ['static', 'server'], needs: ['repository'] },
        { id: 'own', targetClass: 'ownServer', availability: 'available', accepts: ['static', 'server', 'container', 'compose'], needs: [] },
    ] as const;
    const result = resolvePublishTargetRecommendation({ definition: null, deploy: { framework: 'html', output: 'static' }, targets });
    expect(result.compatibleTargetIds).toEqual(['pages', 'vercel', 'own']);
    expect(result.offeredTargetIds).toEqual(['pages', 'vercel', 'own']);
    expect(result.uncertainty).not.toContain('platform_source_capability_unknown');
});
