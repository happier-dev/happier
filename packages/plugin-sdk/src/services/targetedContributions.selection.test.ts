import { describe, expect, expectTypeOf, it } from 'vitest';

import type { AdmittedTargetedOperationExecutionHandle } from '../actions/service.js';
import type { PluginTargetedContributionSelectionV1 } from '../targetedContributionAuthoring.js';
import {
    selectCurrentTargetedContribution,
    type TargetedContributionPointRef,
    type TargetedContributionsService,
} from './targetedContributions.js';

type FixtureContribution = Readonly<{
    contributor: Readonly<{
        pluginId: string;
        contributionId: string;
        immutableGenerationId: string;
    }>;
    protocol: Readonly<{
        id: string;
        version: number;
    }>;
    operations: Readonly<{
        inspect: AdmittedTargetedOperationExecutionHandle<Readonly<{ id: string }>, Readonly<{ ok: true }>, 'inspect'>;
    }>;
}>;

const point: TargetedContributionPointRef<FixtureContribution> = Object.freeze({
    targetPluginId: 'happier.target',
    id: 'providers',
    protocol: Object.freeze({ id: 'happier.target/providers', version: 1 }),
});

const selection = Object.freeze({
    target: Object.freeze({
        pluginId: point.targetPluginId,
        immutableGenerationId: 'target-generation-a',
    }),
    point: Object.freeze({
        pointId: point.id,
        protocol: point.protocol,
    }),
    contributor: Object.freeze({
        pluginId: 'com.example.provider',
        contributionId: 'provider-a',
        immutableGenerationId: 'provider-generation-a',
    }),
}) satisfies PluginTargetedContributionSelectionV1;

const admittedOperation = Object.freeze({
    identity: Object.freeze({
        target: Object.freeze({ pluginId: point.targetPluginId }),
        point: Object.freeze({ pointId: point.id, protocol: point.protocol }),
        contributor: selection.contributor,
        role: 'inspect' as const,
    }),
}) as AdmittedTargetedOperationExecutionHandle<Readonly<{ id: string }>, Readonly<{ ok: true }>, 'inspect'>;

function admittedContribution(overrides: Partial<FixtureContribution> = {}): FixtureContribution {
    return Object.freeze({
        contributor: selection.contributor,
        protocol: point.protocol,
        operations: Object.freeze({ inspect: admittedOperation }),
        ...overrides,
    });
}

function serviceFor(input: Readonly<{
    generation: string;
    contributions: readonly FixtureContribution[];
}>) {
    let observedPoint: TargetedContributionPointRef<unknown> | undefined;
    let disposed = 0;
    let readSignal: AbortSignal | undefined;
    const service: TargetedContributionsService = {
        observeForSelf<TContribution>(
            candidate: TargetedContributionPointRef<TContribution>,
            _options: Readonly<{ onInvalidated: () => void }>,
        ) {
            observedPoint = candidate;
            return {
                dispose() {
                    disposed += 1;
                },
                async readCurrent(options) {
                    readSignal = options?.signal;
                    return {
                        generation: input.generation,
                        contributions: input.contributions as readonly TContribution[],
                    };
                },
            };
        },
    };
    return {
        service,
        observedPoint: () => observedPoint,
        disposed: () => disposed,
        readSignal: () => readSignal,
    };
}

describe('selectCurrentTargetedContribution', () => {
    it('returns the host-issued typed admitted entry for exactly the selected point and current generation', async () => {
        const fixture = serviceFor({
            generation: selection.target.immutableGenerationId,
            contributions: [admittedContribution()],
        });
        const signal = new AbortController().signal;

        const result = await selectCurrentTargetedContribution({
            service: fixture.service,
            point,
            selection,
            signal,
        });

        expect(result).toEqual({
            kind: 'selected',
            targetGeneration: selection.target.immutableGenerationId,
            contribution: admittedContribution(),
        });
        expect(fixture.observedPoint()).toBe(point);
        expect(fixture.readSignal()).toBe(signal);
        expect(fixture.disposed()).toBe(1);
        if (result.kind === 'selected') {
            expect(result.contribution.operations.inspect).toBe(admittedOperation);
            expectTypeOf(result.contribution.operations.inspect)
                .toEqualTypeOf<AdmittedTargetedOperationExecutionHandle<Readonly<{ id: string }>, Readonly<{ ok: true }>, 'inspect'>>();
        }
    });

    it('fails closed when the selected target generation is no longer current', async () => {
        const fixture = serviceFor({
            generation: 'target-generation-b',
            contributions: [admittedContribution()],
        });

        await expect(selectCurrentTargetedContribution({
            service: fixture.service,
            point,
            selection,
        })).resolves.toEqual({
            kind: 'unavailable',
            reason: 'target_generation_stale',
        });
        expect(fixture.disposed()).toBe(1);
    });

    it('fails closed when the selected contributor generation has been replaced', async () => {
        const fixture = serviceFor({
            generation: selection.target.immutableGenerationId,
            contributions: [admittedContribution({
                contributor: Object.freeze({
                    ...selection.contributor,
                    immutableGenerationId: 'provider-generation-b',
                }),
            })],
        });

        await expect(selectCurrentTargetedContribution({
            service: fixture.service,
            point,
            selection,
        })).resolves.toEqual({
            kind: 'unavailable',
            reason: 'contributor_unavailable',
        });
    });

    it('rejects a selection for another point before opening an observation', async () => {
        const fixture = serviceFor({
            generation: selection.target.immutableGenerationId,
            contributions: [admittedContribution()],
        });

        await expect(selectCurrentTargetedContribution({
            service: fixture.service,
            point,
            selection: {
                ...selection,
                point: { ...selection.point, pointId: 'other-point' },
            },
        })).resolves.toEqual({
            kind: 'unavailable',
            reason: 'selection_invalid',
        });
        expect(fixture.observedPoint()).toBeUndefined();
        expect(fixture.disposed()).toBe(0);
    });
});
