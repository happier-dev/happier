import { describe, expect, it } from 'vitest';

import type { Metadata } from '../storageTypes';
import { computeAcpConfigOptionControls } from './configOptionsControl';

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
        expect(res).not.toBeNull();
        expect(res?.[0]).toMatchObject({
            option: { id: 'telemetry', currentValue: 'false' },
            requestedValue: 'true',
            effectiveValue: 'true',
            isPending: true,
        });
    });

    it('hides config options that would duplicate the dedicated Mode/Model controls', () => {
        const metadata = createMetadata({
            acpSessionModesV1: {
                v: 1,
                provider: 'opencode',
                updatedAt: 1,
                currentModeId: 'build',
                availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }],
            },
            acpSessionModelsV1: {
                v: 1,
                provider: 'opencode',
                updatedAt: 1,
                currentModelId: 'm1',
                availableModels: [{ id: 'm1', name: 'Model 1' }],
            },
            acpConfigOptionsV1: {
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

    it('drops malformed options and ignores blank override values', () => {
        const metadata = createMetadata({
            acpConfigOptionsV1: {
                v: 1,
                provider: 'opencode',
                updatedAt: 1,
                configOptions: [
                    { id: 'good', name: 'Good', type: 'string', currentValue: 'enabled' },
                    { id: 'null_current', name: 'Null current', type: 'string', currentValue: null },
                ],
            },
            acpConfigOptionOverridesV1: {
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
            acpConfigOptionsV1: {
                v: 1,
                provider: 'opencode',
                updatedAt: 1,
                configOptions: [
                    { id: 'booleanFlag', name: 'Boolean flag', type: 'boolean', currentValue: false },
                    { id: 'maxRetries', name: 'Max retries', type: 'number', currentValue: 3 },
                ],
            },
            acpConfigOptionOverridesV1: {
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
});
