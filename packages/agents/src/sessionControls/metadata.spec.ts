import { describe, expect, it } from 'vitest';

import {
    LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY,
    readNewestMetadataAliasValue,
    SESSION_MODE_OVERRIDE_KEY,
} from './metadataKeys.js';
import {
    parseSessionAppliedModelMetadataStateV1,
    parseSessionModelsMetadataStateV1,
    readSessionAppliedModelMetadataStateV1,
    resolveMetadataStringOverrideStateV1,
    resolveMetadataStringOverrideStateV1FromAliases,
    resolveMetadataStringOverrideV1,
} from './metadata.js';

describe('sessionAppliedModelV1', () => {
    it('accepts the additive applied-model fact and preserves opaque model ids', () => {
        const state = {
            v: 1,
            provider: 'codex',
            updatedAt: 42,
            modelId: ' gpt-5.6-sol ',
        } as const;

        expect(parseSessionAppliedModelMetadataStateV1(state)).toEqual(state);
        expect(readSessionAppliedModelMetadataStateV1({
            sessionAppliedModelV1: state,
        })).toEqual(state);
    });

    it('rejects malformed applied-model facts', () => {
        expect(parseSessionAppliedModelMetadataStateV1({
            v: 1,
            provider: 'codex',
            updatedAt: 42,
            modelId: '   ',
        })).toBeNull();
        expect(parseSessionAppliedModelMetadataStateV1({
            v: 1,
            provider: 'codex',
            updatedAt: Number.NaN,
            modelId: 'gpt-5.6-sol',
        })).toBeNull();
    });
});

describe('parseSessionModelsMetadataStateV1', () => {
    const base = {
        v: 1,
        provider: 'grok',
        updatedAt: 1,
        currentModelId: 'model-a',
    } as const;

    it('validates the consumed modelOptions container and option ids', () => {
        expect(parseSessionModelsMetadataStateV1({
            ...base,
            availableModels: [{ id: 'model-a', name: 'Model A', modelOptions: 'malformed' }],
        })).toBeNull();
        expect(parseSessionModelsMetadataStateV1({
            ...base,
            availableModels: [{ id: 'model-a', name: 'Model A', modelOptions: [{}] }],
        })).toBeNull();
    });

    it('keeps modelOptions optional and preserves unconsumed option metadata', () => {
        expect(parseSessionModelsMetadataStateV1({
            ...base,
            availableModels: [
                { id: 'model-a', name: 'Model A' },
                {
                    id: 'model-b',
                    name: 'Model B',
                    modelOptions: [{
                        id: 'reasoning_effort',
                        name: 'Thinking',
                        type: 'select',
                        currentValue: 'high',
                        futureMetadata: { revision: 2 },
                    }],
                },
            ],
        })).not.toBeNull();
    });

    it('preserves an extended-context model id and rejects malformed values', () => {
        const parsed = parseSessionModelsMetadataStateV1({
            ...base,
            availableModels: [{
                id: 'model-a',
                name: 'Model A',
                extendedContextModelId: 'model-a[1m]',
            }],
        });

        expect(parsed?.availableModels[0]?.extendedContextModelId).toBe('model-a[1m]');
        expect(parseSessionModelsMetadataStateV1({
            ...base,
            availableModels: [{
                id: 'model-a',
                name: 'Model A',
                extendedContextModelId: 1_000_000,
            }],
        })).toBeNull();
    });
});

describe('readNewestMetadataAliasValue', () => {
    const parse = (raw: unknown): { updatedAt: number; value: string } | null => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const record = raw as Record<string, unknown>;
        return typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) && typeof record.value === 'string'
            ? { updatedAt: record.updatedAt, value: record.value }
            : null;
    };

    it('uses the newest valid alias and the canonical first key on ties', () => {
        expect(readNewestMetadataAliasValue({
            metadata: { canonical: { updatedAt: 1, value: 'old' }, legacy: { updatedAt: 2, value: 'new' } },
            keys: ['canonical', 'legacy'],
            parse,
        })?.value).toBe('new');
        expect(readNewestMetadataAliasValue({
            metadata: { canonical: { updatedAt: 2, value: 'canonical' }, legacy: { updatedAt: 2, value: 'legacy' } },
            keys: ['canonical', 'legacy'],
            parse,
        })?.value).toBe('canonical');
    });

    it('falls back when the newer-looking alias is malformed', () => {
        expect(readNewestMetadataAliasValue({
            metadata: { canonical: { updatedAt: 2 }, legacy: { updatedAt: 1, value: 'valid' } },
            keys: ['canonical', 'legacy'],
            parse,
        })?.value).toBe('valid');
    });
});

describe('resolveMetadataStringOverrideStateV1', () => {
    it('returns a cleared state for explicit null tombstones', () => {
        expect(resolveMetadataStringOverrideStateV1(
            { sessionModeOverrideV1: { v: 1, updatedAt: 101, modeId: null } },
            SESSION_MODE_OVERRIDE_KEY,
            'modeId',
        )).toEqual({ state: 'cleared', updatedAt: 101 });
    });

    it('returns a cleared state for whitespace tombstones', () => {
        expect(resolveMetadataStringOverrideStateV1(
            { sessionModeOverrideV1: { v: 1, updatedAt: 102, modeId: '   ' } },
            SESSION_MODE_OVERRIDE_KEY,
            'modeId',
        )).toEqual({ state: 'cleared', updatedAt: 102 });
    });

    it('ignores malformed override objects that omit the value key', () => {
        expect(resolveMetadataStringOverrideStateV1(
            { sessionModeOverrideV1: { v: 1, updatedAt: 103 } },
            SESSION_MODE_OVERRIDE_KEY,
            'modeId',
        )).toBeNull();
    });

    it('keeps the legacy string override reader set-only', () => {
        expect(resolveMetadataStringOverrideV1(
            { sessionModeOverrideV1: { v: 1, updatedAt: 104, modeId: null } },
            SESSION_MODE_OVERRIDE_KEY,
            'modeId',
        )).toBeNull();
    });

    it('preserves exact nonblank opaque override values', () => {
        expect(resolveMetadataStringOverrideStateV1(
            { sessionModeOverrideV1: { v: 1, updatedAt: 105, modeId: ' plan ' } },
            SESSION_MODE_OVERRIDE_KEY,
            'modeId',
        )).toEqual({ state: 'set', value: ' plan ', updatedAt: 105 });
    });
});

describe('resolveMetadataStringOverrideStateV1FromAliases', () => {
    it('ignores malformed canonical timestamps before selecting the newest alias', () => {
        expect(resolveMetadataStringOverrideStateV1FromAliases(
            {
                sessionModeOverrideV1: { v: 1, updatedAt: Number.NaN, modeId: 'plan' },
                acpSessionModeOverrideV1: { v: 1, updatedAt: -1, modeId: 'build' },
            },
            [SESSION_MODE_OVERRIDE_KEY, LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY],
            'modeId',
        )).toEqual({ state: 'set', value: 'build', updatedAt: -1 });
    });

    it('prefers a newer canonical clear over a stale legacy value', () => {
        expect(resolveMetadataStringOverrideStateV1FromAliases(
            {
                sessionModeOverrideV1: { v: 1, updatedAt: 101, modeId: null },
                acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
            },
            [SESSION_MODE_OVERRIDE_KEY, LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY],
            'modeId',
        )).toEqual({ state: 'cleared', updatedAt: 101 });
    });

    it('prefers a newer legacy clear over a stale canonical value', () => {
        expect(resolveMetadataStringOverrideStateV1FromAliases(
            {
                sessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
                acpSessionModeOverrideV1: { v: 1, updatedAt: 101, modeId: null },
            },
            [SESSION_MODE_OVERRIDE_KEY, LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY],
            'modeId',
        )).toEqual({ state: 'cleared', updatedAt: 101 });
    });

    it('prefers the canonical state when alias timestamps tie', () => {
        expect(resolveMetadataStringOverrideStateV1FromAliases(
            {
                sessionModeOverrideV1: { v: 1, updatedAt: 101, modeId: 'plan' },
                acpSessionModeOverrideV1: { v: 1, updatedAt: 101, modeId: null },
            },
            [SESSION_MODE_OVERRIDE_KEY, LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY],
            'modeId',
        )).toEqual({ state: 'set', value: 'plan', updatedAt: 101 });
    });
});
