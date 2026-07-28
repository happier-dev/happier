import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import {
    readSessionConfigOptionOverridesState,
    readSessionConfigOptionsState,
    readSessionModelsState,
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
                availableModels: [{ id: 'legacy-model', name: 'Legacy model' }],
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

        expect(readSessionModelsState(value)?.currentModelId).toBe('legacy-model');
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
});
