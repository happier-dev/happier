import { describe, expect, it } from 'vitest';

import type { Metadata } from '../domains/state/storageTypes';
import {
    computeAcpConfigOptionControls,
    computeAcpConfigOptionControlsForProvider,
} from './configOptionsControl';

function createMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp',
        host: 'h',
        ...overrides,
    } as Metadata;
}

describe('computeAcpConfigOptionControls', () => {
    it('returns null when ACP config options are missing', () => {
        expect(computeAcpConfigOptionControls({ agentId: 'opencode', metadata: null })).toBeNull();
        expect(computeAcpConfigOptionControls({ agentId: 'opencode', metadata: createMetadata() })).toBeNull();
    });

    it('returns null when provider does not match the session agent', () => {
        const metadata = createMetadata({
            acpConfigOptionsV1: {
                v: 1,
                provider: 'qwen',
                updatedAt: 1,
                configOptions: [{ id: 'telemetry', name: 'Telemetry', type: 'boolean', currentValue: 'false' }],
            },
        });

        expect(computeAcpConfigOptionControls({ agentId: 'opencode', metadata })).toBeNull();
    });

    it('returns config options with pending state when override differs from currentValue', () => {
        const metadata = createMetadata({
            sessionConfigOptionsV1: {
                v: 1,
                provider: 'opencode',
                updatedAt: 1,
                configOptions: [{ id: 'telemetry', name: 'Telemetry', type: 'boolean', currentValue: 'false' }],
            },
            sessionConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 2,
                overrides: { telemetry: { updatedAt: 2, value: 'true' } },
            },
        });

        const res = computeAcpConfigOptionControls({ agentId: 'opencode', metadata });
        expect(res).not.toBeNull();
        expect(res?.[0]).toMatchObject({
            option: { id: 'telemetry', currentValue: 'false' },
            requestedValue: 'true',
            effectiveValue: 'false',
            isPending: true,
        });
    });

    it('ignores requested select values that are not valid options', () => {
        const metadata = createMetadata({
            sessionConfigOptionsV1: {
                v: 1,
                provider: 'opencode',
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

        const res = computeAcpConfigOptionControls({ agentId: 'opencode', metadata });
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
                provider: 'opencode',
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

        const res = computeAcpConfigOptionControls({ agentId: 'opencode', metadata });
        expect(res?.[0]).toMatchObject({
            requestedValue: 'high',
            effectiveValue: 'medium',
            isPending: true,
        });
    });

    it('normalizes legacy Extra High option labels without changing the option value', () => {
        const metadata = createMetadata({
            sessionConfigOptionsV1: {
                v: 1,
                provider: 'cursor',
                updatedAt: 1,
                configOptions: [{
                    id: 'reasoning_effort',
                    name: 'Reasoning effort',
                    type: 'select',
                    currentValue: 'extra-high',
                    options: [
                        { value: 'high', name: 'High' },
                        { value: 'extra-high', name: 'Extra High' },
                    ],
                }],
            },
        });

        const res = computeAcpConfigOptionControls({ agentId: 'cursor', metadata });

        expect(res?.[0]?.option.options).toEqual([
            { value: 'high', name: 'High' },
            { value: 'extra-high', name: 'XHigh' },
        ]);
    });

    it('normalizes legacy fast true option labels without changing the option value', () => {
        const metadata = createMetadata({
            sessionConfigOptionsV1: {
                v: 1,
                provider: 'cursor',
                updatedAt: 1,
                configOptions: [{
                    id: 'fast',
                    name: 'Fast',
                    type: 'boolean',
                    currentValue: 'false',
                    options: [
                        { value: 'false', name: 'Off' },
                        { value: 'true', name: 'On' },
                    ],
                }],
            },
        });

        const res = computeAcpConfigOptionControls({ agentId: 'cursor', metadata });

        expect(res?.[0]?.option.options).toEqual([
            { value: 'false', name: 'Off' },
            { value: 'true', name: 'Fast' },
        ]);
    });

    it('hides config options that would duplicate the dedicated Mode/Model controls', () => {
        const metadata = createMetadata({
            sessionModesV1: {
                v: 1,
                provider: 'opencode',
                updatedAt: 1,
                currentModeId: 'build',
                availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }],
            },
            sessionModelsV1: {
                v: 1,
                provider: 'opencode',
                updatedAt: 1,
                currentModelId: 'm1',
                availableModels: [{ id: 'm1', name: 'Model 1' }],
            },
            sessionConfigOptionsV1: {
                v: 1,
                provider: 'opencode',
                updatedAt: 1,
                configOptions: [
                    { id: 'mode', name: 'Mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'Build' }] },
                    { id: 'models', name: 'Model', type: 'select', currentValue: 'm1', options: [{ value: 'm1', name: 'Model 1' }] },
                    { id: 'telemetry', name: 'Telemetry', type: 'boolean', currentValue: 'false' },
                ],
            },
        });

        const res = computeAcpConfigOptionControls({ agentId: 'opencode', metadata });
        expect(res?.map((control) => control.option.id)).toEqual(['telemetry']);
    });

    it('hides model config options from override controls when model options own them', () => {
        const res = computeAcpConfigOptionControlsForProvider({
            providerId: 'cursor',
            hideModeOption: true,
            hideModelOption: true,
            configOptions: [
                {
                    id: 'mode',
                    name: 'Mode',
                    type: 'select',
                    currentValue: 'agent',
                    options: [{ value: 'agent', name: 'Agent' }],
                },
                {
                    id: 'model',
                    name: 'Model',
                    type: 'select',
                    currentValue: 'composer-2.5',
                    options: [{ value: 'composer-2.5', name: 'Composer 2.5' }],
                },
                {
                    id: 'fast',
                    name: 'Fast',
                    description: 'Faster speeds.',
                    category: 'model_config',
                    type: 'select',
                    currentValue: 'true',
                    options: [
                        { value: 'false', name: 'Off' },
                        { value: 'true', name: 'Fast' },
                    ],
                },
                {
                    id: 'telemetry',
                    name: 'Telemetry',
                    type: 'boolean',
                    currentValue: 'false',
                },
            ],
        });

        expect(res?.map((control) => control.option.id)).toEqual(['telemetry']);
    });

    it('drops malformed options and ignores blank override values', () => {
        const metadata = createMetadata({
            sessionConfigOptionsV1: {
                v: 1,
                provider: 'opencode',
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

        const res = computeAcpConfigOptionControls({ agentId: 'opencode', metadata });
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
                provider: 'opencode',
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

        const res = computeAcpConfigOptionControls({ agentId: 'opencode', metadata });
        expect(res).toEqual([
            expect.objectContaining({
                option: expect.objectContaining({ id: 'booleanFlag', currentValue: 'false' }),
                requestedValue: 'true',
                effectiveValue: 'false',
                isPending: true,
            }),
            expect.objectContaining({
                option: expect.objectContaining({ id: 'maxRetries', currentValue: '3' }),
                requestedValue: '5',
                effectiveValue: '3',
                isPending: true,
            }),
        ]);
    });

    it('falls back to legacy ACP keys when canonical config keys are absent', () => {
        const metadata = createMetadata({
            acpConfigOptionsV1: {
                v: 1,
                provider: 'opencode',
                updatedAt: 1,
                configOptions: [{ id: 'telemetry', name: 'Telemetry', type: 'boolean', currentValue: 'false' }],
            },
            acpConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 2,
                overrides: { telemetry: { updatedAt: 2, value: 'true' } },
            },
        });

        const res = computeAcpConfigOptionControls({ agentId: 'opencode', metadata });
        expect(res?.[0]?.effectiveValue).toBe('false');
    });
});

describe('ultracode override of the reasoning effort control', () => {
    const configOptions = [
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
        { id: 'ultracode', name: 'Ultracode', type: 'boolean', currentValue: 'false' },
    ];

    it('keeps reasoning effort enabled while an ultracode request is pending provider confirmation', () => {
        const controls = computeAcpConfigOptionControlsForProvider({
            providerId: 'claude',
            configOptions,
            overrides: { ultracode: { value: 'true' } },
        });
        const effort = controls?.find((control) => control.option.id === 'reasoning_effort');
        expect(effort?.disabled).not.toBe(true);
        expect(effort?.disabledByOptionName).toBeUndefined();
        const ultracode = controls?.find((control) => control.option.id === 'ultracode');
        expect(ultracode?.disabled).not.toBe(true);
    });

    it('disables reasoning effort after the provider confirms ultracode', () => {
        const controls = computeAcpConfigOptionControlsForProvider({
            providerId: 'claude',
            configOptions: configOptions.map((option) => option.id === 'ultracode'
                ? { ...option, currentValue: 'true' }
                : option),
        });
        const effort = controls?.find((control) => control.option.id === 'reasoning_effort');
        expect(effort?.disabled).toBe(true);
        expect(effort?.disabledByOptionName).toBe('Ultracode');
    });

    it('keeps the reasoning effort control enabled while ultracode is off', () => {
        const controls = computeAcpConfigOptionControlsForProvider({
            providerId: 'claude',
            configOptions,
        });
        const effort = controls?.find((control) => control.option.id === 'reasoning_effort');
        expect(effort?.disabled).not.toBe(true);
        expect(effort?.disabledByOptionName).toBeUndefined();
    });
});
