import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import {
    readSessionConfigOptionOverridesState,
    readSessionConfigOptionsState,
    readSessionModeOverrideState,
    readSessionModelsState,
    readSessionModesState,
} from './readSessionControlMetadata';

function metadata(overrides: Partial<Metadata>): Metadata {
    return { path: '/tmp/project', host: 'localhost', ...overrides };
}

describe('readSessionControlMetadata', () => {
    it('selects the newest valid model and config aliases and prefers canonical ties', () => {
        const value = metadata({
            sessionModelsV1: {
                v: 1, provider: 'grok', updatedAt: 10, currentModelId: 'canonical-model',
                availableModels: [{ id: 'canonical-model', name: 'Canonical model' }],
            },
            acpSessionModelsV1: {
                v: 1, provider: 'grok', updatedAt: 20, currentModelId: 'legacy-model',
                availableModels: [{
                    id: 'legacy-model',
                    name: 'Legacy model',
                    extendedContextModelId: 'legacy-model[1m]',
                }],
            },
            sessionConfigOptionsV1: {
                v: 1, provider: 'grok', updatedAt: 30,
                configOptions: [{ id: 'effort', name: 'Effort', type: 'select', currentValue: 'high' }],
            },
            acpConfigOptionsV1: {
                v: 1, provider: 'grok', updatedAt: 30,
                configOptions: [{ id: 'effort', name: 'Effort', type: 'select', currentValue: 'low' }],
            },
        });

        const models = readSessionModelsState(value);
        expect(models?.currentModelId).toBe('legacy-model');
        expect(models?.availableModels[0]?.extendedContextModelId).toBe('legacy-model[1m]');
        expect(readSessionConfigOptionsState(value)?.configOptions[0]?.currentValue).toBe('high');
    });

    it('selects the newest valid config-command alias and preserves tombstones', () => {
        const value = metadata({
            sessionConfigOptionOverridesV1: {
                v: 1, updatedAt: 10, overrides: { reasoning_effort: { updatedAt: 10, value: 'high' } },
            },
            acpConfigOptionOverridesV1: {
                v: 1, updatedAt: 20, overrides: { reasoning_effort: { updatedAt: 20, value: null } },
            },
        });

        expect(readSessionConfigOptionOverridesState(value)).toEqual(value.acpConfigOptionOverridesV1);
    });

    it('selects a newer valid legacy mode state and ignores a malformed canonical state', () => {
        const value = metadata({
            sessionModesV1: {
                v: 1, provider: 'grok', updatedAt: Number.NaN, currentModeId: 'canonical-mode',
                availableModes: [{ id: 'canonical-mode', name: 'Canonical mode' }],
            },
            acpSessionModesV1: {
                v: 1, provider: 'grok', updatedAt: 20, currentModeId: 'legacy-mode',
                availableModes: [{ id: 'legacy-mode', name: 'Legacy mode' }],
            },
        });

        expect(readSessionModesState(value)?.currentModeId).toBe('legacy-mode');
    });

    it('preserves a newer legacy mode tombstone and prefers canonical ties', () => {
        const cleared = metadata({
            sessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
            acpSessionModeOverrideV1: { v: 1, updatedAt: 20, modeId: null },
        });
        expect(readSessionModeOverrideState(cleared)).toEqual({ state: 'cleared', updatedAt: 20 });

        const tied = metadata({
            sessionModeOverrideV1: { v: 1, updatedAt: 30, modeId: 'canonical-mode' },
            acpSessionModeOverrideV1: { v: 1, updatedAt: 30, modeId: 'legacy-mode' },
        });
        expect(readSessionModeOverrideState(tied)).toEqual({
            state: 'set',
            value: 'canonical-mode',
            updatedAt: 30,
        });
    });
});
