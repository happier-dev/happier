import { describe, expect, it } from 'vitest';

import type { Metadata } from '../state/storageTypes';
import { computeSessionConfigOptionControls,
    computeSessionConfigOptionControlsForProvider,
} from './configOptionsControl';

function createMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp',
        host: 'h',
        ...overrides,
    } as Metadata;
}

describe('computeSessionConfigOptionControls', () => {
    it('returns null when ACP config options are missing', () => {
        expect(computeSessionConfigOptionControls({ agentId: 'opencode', metadata: null })).toBeNull();
        expect(computeSessionConfigOptionControls({ agentId: 'opencode', metadata: createMetadata() })).toBeNull();
    });

    it('returns null when the metadata agent does not match the session agent', () => {
        const metadata = createMetadata({
            acpConfigOptionsV1: {
                v: 1,
                agentId: 'qwen',
                updatedAt: 1,
                configOptions: [{ id: 'telemetry', name: 'Telemetry', type: 'boolean', currentValue: 'false' }],
            },
        });

        expect(computeSessionConfigOptionControls({ agentId: 'opencode', metadata })).toBeNull();
    });

    it('returns config options with pending state when override differs from currentValue', () => {
        const metadata = createMetadata({
            sessionConfigOptionsV1: {
                v: 1,
                agentId: 'opencode',
                updatedAt: 1,
                configOptions: [{ id: 'telemetry', name: 'Telemetry', type: 'boolean', currentValue: 'false' }],
            },
            sessionConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 2,
                overrides: { telemetry: { updatedAt: 2, value: 'true' } },
            },
        });

        const res = computeSessionConfigOptionControls({ agentId: 'opencode', metadata });
        expect(res).not.toBeNull();
        expect(res?.[0]).toMatchObject({
            option: { id: 'telemetry', currentValue: 'false' },
            requestedValue: 'true',
            effectiveValue: 'true',
            isPending: true,
        });
    });

    it('ignores requested select values that are not valid options', () => {
        const metadata = createMetadata({
            sessionConfigOptionsV1: {
                v: 1,
                agentId: 'opencode',
                updatedAt: 1,
                configOptions: [{
                    id: 'reasoning_effort',
                    name: 'Reasoning effort',
                    type: 'select',
                    currentValue: 'medium',
                    options: [
                        { value: 'low', name: 'Low' },
                        { value: 'medium', name: 'Medium' },
                        { value: 'high', name: 'High' },
                    ],
                }],
            },
            sessionConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 2,
                overrides: { reasoning_effort: { updatedAt: 2, value: 'xhigh' } },
            },
        });

        const res = computeSessionConfigOptionControls({ agentId: 'opencode', metadata });
        expect(res?.[0]).toMatchObject({
            option: { id: 'reasoning_effort', currentValue: 'medium' },
            effectiveValue: 'medium',
            isPending: false,
        });
        expect(res?.[0]?.requestedValue).toBeUndefined();
    });

    it('keeps requested select values that are valid options', () => {
        const metadata = createMetadata({
            sessionConfigOptionsV1: {
                v: 1,
                agentId: 'opencode',
                updatedAt: 1,
                configOptions: [{
                    id: 'reasoning_effort',
                    name: 'Reasoning effort',
                    type: 'select',
                    currentValue: 'medium',
                    options: [
                        { value: 'medium', name: 'Medium' },
                        { value: 'high', name: 'High' },
                    ],
                }],
            },
            sessionConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 2,
                overrides: { reasoning_effort: { updatedAt: 2, value: 'high' } },
            },
        });

        const res = computeSessionConfigOptionControls({ agentId: 'opencode', metadata });
        expect(res?.[0]).toMatchObject({
            requestedValue: 'high',
            effectiveValue: 'high',
            isPending: true,
        });
    });

    it('preserves grouped config choices for the control while validating selections across groups', () => {
        const metadata = createMetadata({
            sessionConfigOptionsV1: {
                v: 1,
                agentId: 'opencode',
                updatedAt: 1,
                configOptions: [{
                    id: 'model',
                    name: 'Model',
                    type: 'select',
                    currentValue: 'model-1',
                    groups: [{
                        id: 'curated',
                        name: 'Curated',
                        options: [{ value: 'model-1', name: 'Model 1' }],
                    }, {
                        id: 'external',
                        name: 'External',
                        options: [{ value: 'model-2', name: 'Model 2' }],
                    }],
                }],
            },
            sessionConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 2,
                overrides: { model: { updatedAt: 2, value: 'model-2' } },
            },
        });

        expect(computeSessionConfigOptionControls({ agentId: 'opencode', metadata })).toEqual([
            expect.objectContaining({
                option: expect.objectContaining({
                    id: 'model',
                    groups: [
                        expect.objectContaining({ id: 'curated' }),
                        expect.objectContaining({ id: 'external' }),
                    ],
                }),
                requestedValue: 'model-2',
                effectiveValue: 'model-2',
                isPending: true,
            }),
        ]);
    });

    it('preserves opaque whitespace config values when selecting a grouped choice', () => {
        const metadata = createMetadata({
            sessionConfigOptionsV1: {
                v: 1,
                agentId: 'opencode',
                updatedAt: 1,
                configOptions: [{
                    id: ' model ',
                    name: 'Model',
                    type: 'select',
                    currentValue: ' model-1 ',
                    groups: [{
                        id: ' curated ',
                        name: 'Curated',
                        options: [{ value: ' model-1 ', name: 'Model 1' }],
                    }, {
                        id: ' external ',
                        name: 'External',
                        options: [{ value: ' model-2 ', name: 'Model 2' }],
                    }],
                }],
            },
            sessionConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 2,
                overrides: { ' model ': { updatedAt: 2, value: ' model-2 ' } },
            },
        });

        expect(computeSessionConfigOptionControls({ agentId: 'opencode', metadata })).toEqual([
            expect.objectContaining({
                option: expect.objectContaining({
                    id: ' model ',
                    currentValue: ' model-1 ',
                    groups: [
                        expect.objectContaining({ id: ' curated ', options: [expect.objectContaining({ value: ' model-1 ' })] }),
                        expect.objectContaining({ id: ' external ', options: [expect.objectContaining({ value: ' model-2 ' })] }),
                    ],
                }),
                requestedValue: ' model-2 ',
                effectiveValue: ' model-2 ',
                isPending: true,
            }),
        ]);
    });

    it('keeps usable groups when the SDK includes an empty group', () => {
        const metadata = createMetadata({
            sessionConfigOptionsV1: {
                v: 1,
                agentId: 'opencode',
                updatedAt: 1,
                configOptions: [{
                    id: 'model',
                    name: 'Model',
                    type: 'select',
                    currentValue: 'model-1',
                    groups: [{
                        id: 'recent',
                        name: 'Recent',
                        options: [],
                    }, {
                        id: 'curated',
                        name: 'Curated',
                        options: [{ value: 'model-1', name: 'Model 1' }],
                    }],
                }],
            },
        });

        expect(computeSessionConfigOptionControls({ agentId: 'opencode', metadata })).toEqual([
            expect.objectContaining({
                option: expect.objectContaining({
                    id: 'model',
                    groups: [expect.objectContaining({ id: 'curated' })],
                }),
                effectiveValue: 'model-1',
            }),
        ]);
    });

    it('hides ambiguous duplicate group, choice, and config identifiers', () => {
        const metadata = createMetadata({
            sessionConfigOptionsV1: {
                v: 1,
                agentId: 'opencode',
                updatedAt: 1,
                configOptions: [{
                    id: 'telemetry',
                    name: 'Telemetry',
                    type: 'boolean',
                    currentValue: 'false',
                }, {
                    id: 'model',
                    name: 'Model',
                    type: 'select',
                    currentValue: 'model-1',
                    groups: [{ id: 'catalog', name: 'Catalog', options: [{ value: 'model-1', name: 'Model 1' }] }, {
                        id: 'catalog', name: 'Other catalog', options: [{ value: 'model-2', name: 'Model 2' }],
                    }],
                }, {
                    id: 'effort',
                    name: 'Effort',
                    type: 'select',
                    currentValue: 'low',
                    groups: [{
                        id: 'levels',
                        name: 'Levels',
                        options: [{ value: 'low', name: 'Low' }, { value: 'low', name: 'Low duplicate' }],
                    }],
                }, {
                    id: 'duplicate',
                    name: 'First duplicate',
                    type: 'boolean',
                    currentValue: 'false',
                }, {
                    id: 'duplicate',
                    name: 'Second duplicate',
                    type: 'boolean',
                    currentValue: 'true',
                }],
            },
        });

        expect(computeSessionConfigOptionControls({ agentId: 'opencode', metadata })?.map((control) => control.option.id))
            .toEqual(['telemetry']);
    });

    it('hides config options that would duplicate the dedicated Mode/Model controls', () => {
        const metadata = createMetadata({
            sessionModesV1: {
                v: 1,
                agentId: 'opencode',
                updatedAt: 1,
                currentModeId: 'build',
                availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }],
            },
            sessionModelsV1: {
                v: 1,
                agentId: 'opencode',
                updatedAt: 1,
                currentModelId: 'm1',
                availableModels: [{ id: 'm1', name: 'Model 1' }],
            },
            sessionConfigOptionsV1: {
                v: 1,
                agentId: 'opencode',
                updatedAt: 1,
                configOptions: [
                    { id: 'mode', name: 'Mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'Build' }] },
                    { id: 'models', name: 'Model', type: 'select', currentValue: 'm1', options: [{ value: 'm1', name: 'Model 1' }] },
                    { id: 'telemetry', name: 'Telemetry', type: 'boolean', currentValue: 'false' },
                ],
            },
        });

        const res = computeSessionConfigOptionControls({ agentId: 'opencode', metadata });
        expect(res?.map((control) => control.option.id)).toEqual(['telemetry']);
    });

    it('drops malformed options and ignores blank override values', () => {
        const metadata = createMetadata({
            sessionConfigOptionsV1: {
                v: 1,
                agentId: 'opencode',
                updatedAt: 1,
                configOptions: [
                    { id: 'good', name: 'Good', type: 'string', currentValue: 'enabled' },
                    { id: 'null_current', name: 'Null current', type: 'string', currentValue: null },
                ],
            },
            sessionConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 2,
                overrides: {
                    good: { updatedAt: 2, value: '   ' },
                },
            },
        });

        const res = computeSessionConfigOptionControls({ agentId: 'opencode', metadata });
        expect(res).toHaveLength(1);
        expect(res?.[0]).toMatchObject({
            option: { id: 'good', currentValue: 'enabled' },
            effectiveValue: 'enabled',
            isPending: false,
        });
    });

    it('normalizes boolean and numeric values to string ids', () => {
        const metadata = createMetadata({
            sessionConfigOptionsV1: {
                v: 1,
                agentId: 'opencode',
                updatedAt: 1,
                configOptions: [
                    { id: 'booleanFlag', name: 'Boolean flag', type: 'boolean', currentValue: false },
                    { id: 'maxRetries', name: 'Max retries', type: 'number', currentValue: 3 },
                ],
            },
            sessionConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 2,
                overrides: {
                    booleanFlag: { updatedAt: 2, value: true },
                    maxRetries: { updatedAt: 2, value: 5 },
                },
            },
        });

        const res = computeSessionConfigOptionControls({ agentId: 'opencode', metadata });
        expect(res).toEqual([
            expect.objectContaining({
                option: expect.objectContaining({ id: 'booleanFlag', currentValue: 'false' }),
                requestedValue: 'true',
                effectiveValue: 'true',
                isPending: true,
            }),
            expect.objectContaining({
                option: expect.objectContaining({ id: 'maxRetries', currentValue: '3' }),
                requestedValue: '5',
                effectiveValue: '5',
                isPending: true,
            }),
        ]);
    });

    it('falls back to legacy ACP keys when canonical config keys are absent', () => {
        const metadata = createMetadata({
            acpConfigOptionsV1: {
                v: 1,
                agentId: 'opencode',
                updatedAt: 1,
                configOptions: [{ id: 'telemetry', name: 'Telemetry', type: 'boolean', currentValue: 'false' }],
            },
            acpConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 2,
                overrides: { telemetry: { updatedAt: 2, value: 'true' } },
            },
        });

        const res = computeSessionConfigOptionControls({ agentId: 'opencode', metadata });
        expect(res?.[0]?.effectiveValue).toBe('true');
    });

    it('uses the newest config option override entry across canonical and legacy aliases', () => {
        const metadata = createMetadata({
            sessionConfigOptionsV1: {
                v: 1,
                agentId: 'opencode',
                updatedAt: 1,
                configOptions: [{ id: 'telemetry', name: 'Telemetry', type: 'boolean', currentValue: 'false' }],
            },
            sessionConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 2,
                overrides: { telemetry: { updatedAt: 2, value: false } },
            },
            acpConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 3,
                overrides: { telemetry: { updatedAt: 3, value: true } },
            },
        });

        const res = computeSessionConfigOptionControls({ agentId: 'opencode', metadata });
        expect(res?.[0]).toMatchObject({
            requestedValue: 'true',
            effectiveValue: 'true',
            isPending: true,
        });
    });
});

describe('overriding boolean option dimming (ultracode)', () => {
    it('marks reasoning_effort disabled while ultracode is effectively on', () => {
        const controls = computeSessionConfigOptionControlsForProvider({
            providerId: 'claude',
            configOptions: [
                {
                    id: 'reasoning_effort',
                    name: 'Thinking',
                    type: 'select',
                    currentValue: 'high',
                    options: [
                        { value: 'high', name: 'High' },
                        { value: 'xhigh', name: 'XHigh' },
                    ],
                },
                {
                    id: 'ultracode',
                    name: 'Ultracode',
                    type: 'boolean',
                    currentValue: 'false',
                },
            ],
            overrides: { ultracode: { value: 'true' } },
        });

        const effort = controls?.find((control) => control.option.id === 'reasoning_effort');
        expect(effort?.disabled).toBe(true);
        expect(effort?.disabledByOptionName).toBe('Ultracode');
        const ultracode = controls?.find((control) => control.option.id === 'ultracode');
        expect(ultracode?.disabled).toBeUndefined();
    });

    it('keeps reasoning_effort enabled while ultracode is off', () => {
        const controls = computeSessionConfigOptionControlsForProvider({
            providerId: 'claude',
            configOptions: [
                {
                    id: 'reasoning_effort',
                    name: 'Thinking',
                    type: 'select',
                    currentValue: 'high',
                    options: [{ value: 'high', name: 'High' }],
                },
                {
                    id: 'ultracode',
                    name: 'Ultracode',
                    type: 'boolean',
                    currentValue: 'false',
                },
            ],
        });

        const effort = controls?.find((control) => control.option.id === 'reasoning_effort');
        expect(effort?.disabled).toBeUndefined();
        expect(effort?.disabledByOptionName).toBeUndefined();
    });
});
