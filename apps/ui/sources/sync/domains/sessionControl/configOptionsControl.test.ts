import { describe, expect, it } from 'vitest';

import {
    AgentModelOptionOverrideRuleSchema,
    AgentModelOptionSchema,
    createSessionOwnerMetadataV1,
} from '@happier-dev/protocol';

import { MetadataSchema, type Metadata } from '../state/storageTypes';
import { computeSessionConfigOptionControls,
    computeSessionConfigOptionControlsForProvider,
    computeSessionConfigOptionControlsFromOverride,
    normalizeAcpConfigOptionsArray,
    resolveSessionConfigOptionOverridesFromMetadata,
} from './configOptionsControl';
import { parseSessionModelsState } from './schema';

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

describe('overriding boolean option dimming (producer-declared)', () => {
    const EFFORT_OPTION = {
        id: 'reasoning_effort',
        name: 'Thinking',
        type: 'select',
        currentValue: 'low',
        options: [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' },
            { value: 'xhigh', name: 'XHigh' },
        ],
    } as const;
    const ULTRACODE_WITH_RULE = {
        id: 'ultracode',
        name: 'Ultracode',
        type: 'boolean',
        currentValue: 'false',
        overridesWhenOn: { optionIds: ['reasoning_effort'], forcedValue: 'xhigh' },
    } as const;

    it('marks reasoning_effort disabled while ultracode is effectively on', () => {
        const controls = computeSessionConfigOptionControlsForProvider({
            providerId: 'claude',
            configOptions: [EFFORT_OPTION, ULTRACODE_WITH_RULE],
            overrides: { ultracode: { value: 'true' } },
        });

        const effort = controls?.find((control) => control.option.id === 'reasoning_effort');
        expect(effort?.disabled).toBe(true);
        expect(effort?.disabledByOptionName).toBe('Ultracode');
        const ultracode = controls?.find((control) => control.option.id === 'ultracode');
        expect(ultracode?.disabled).toBeUndefined();
    });

    it('advertises the forced running value without overwriting the stored user intent', () => {
        const controls = computeSessionConfigOptionControlsForProvider({
            providerId: 'claude',
            configOptions: [EFFORT_OPTION, ULTRACODE_WITH_RULE],
            overrides: { ultracode: { value: 'true' } },
        });

        const effort = controls?.find((control) => control.option.id === 'reasoning_effort');
        // The agent runs at xhigh …
        expect(effort?.overriddenEffectiveValue).toBe('xhigh');
        // … while the value that resumes when ultracode is switched off stays untouched.
        expect(effort?.effectiveValue).toBe('low');
    });

    it('dims without advertising a value the option cannot render', () => {
        const controls = computeSessionConfigOptionControlsForProvider({
            providerId: 'claude',
            configOptions: [
                { ...EFFORT_OPTION, options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
                ULTRACODE_WITH_RULE,
            ],
            overrides: { ultracode: { value: 'true' } },
        });

        const effort = controls?.find((control) => control.option.id === 'reasoning_effort');
        expect(effort?.disabled).toBe(true);
        expect(effort?.overriddenEffectiveValue).toBeUndefined();
    });

    it('overrides only the option ids the producer named', () => {
        const controls = computeSessionConfigOptionControlsForProvider({
            providerId: 'claude',
            configOptions: [
                EFFORT_OPTION,
                { id: 'effort', name: 'Effort', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] },
                ULTRACODE_WITH_RULE,
            ],
            overrides: { ultracode: { value: 'true' } },
        });

        expect(controls?.find((control) => control.option.id === 'reasoning_effort')?.disabled).toBe(true);
        expect(controls?.find((control) => control.option.id === 'effort')?.disabled).toBeUndefined();
    });

    it('keeps reasoning_effort enabled while ultracode is off', () => {
        const controls = computeSessionConfigOptionControlsForProvider({
            providerId: 'claude',
            configOptions: [EFFORT_OPTION, ULTRACODE_WITH_RULE],
        });

        const effort = controls?.find((control) => control.option.id === 'reasoning_effort');
        expect(effort?.disabled).toBeUndefined();
        expect(effort?.disabledByOptionName).toBeUndefined();
        expect(effort?.overriddenEffectiveValue).toBeUndefined();
    });

    it('ignores a boolean option that declares no override rule', () => {
        const controls = computeSessionConfigOptionControlsForProvider({
            providerId: 'opencode',
            configOptions: [
                EFFORT_OPTION,
                { id: 'ultracode', name: 'Ultracode', type: 'boolean', currentValue: 'false' },
            ],
            overrides: { ultracode: { value: 'true' } },
        });

        expect(controls?.find((control) => control.option.id === 'reasoning_effort')?.disabled).toBeUndefined();
    });

    // Option ids are agent-supplied. A plain object literal keyed by them resolves
    // `Object.prototype.toString` for an option called `toString`, which used to yield a truthy
    // "rule" and then throw when iterated.
    it('does not resolve override rules off Object.prototype for prototype-named option ids', () => {
        const compute = () => computeSessionConfigOptionControlsForProvider({
            providerId: 'opencode',
            configOptions: [
                { id: 'toString', name: 'To string', type: 'boolean', currentValue: 'false' },
                { id: 'constructor', name: 'Constructor', type: 'boolean', currentValue: 'false' },
                EFFORT_OPTION,
            ],
            overrides: {
                toString: { value: 'true' },
                constructor: { value: 'true' },
            },
        });
        expect(compute).not.toThrow();

        const controls = compute();
        expect(controls?.map((control) => control.option.id))
            .toEqual(['toString', 'constructor', 'reasoning_effort']);
        expect(controls?.every((control) => control.disabled === undefined)).toBe(true);
    });
});

/**
 * The override rule is authored by an agent plugin and has to survive every hand-enumerated
 * schema/reconstruction point between there and the control the user sees. None of those points
 * is type-checked against the producer, so a dropped or rejected field fails silently (or, on the
 * strict owner envelope, loudly rejects the whole session metadata). These tests therefore call
 * the REAL boundary functions -- the protocol option schema, the owner-metadata envelope, the
 * persisted `MetadataSchema` parse, and the control builders -- rather than a serialize/parse
 * round-trip that would pass against a broken schema.
 */
describe('overridesWhenOn survives the real publication boundaries', () => {
    const OVERRIDE_RULE = { optionIds: ['reasoning_effort'], forcedValue: 'xhigh' } as const;

    const REASONING_OPTION = {
        id: 'reasoning_effort',
        name: 'Thinking',
        type: 'select',
        currentValue: 'high',
        options: [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' },
            { value: 'xhigh', name: 'XHigh' },
        ],
    } as const;
    const ULTRACODE_OPTION = {
        id: 'ultracode',
        name: 'Ultracode',
        type: 'boolean',
        currentValue: 'false',
        overridesWhenOn: OVERRIDE_RULE,
    } as const;
    const AUTHORED_OPTIONS = [REASONING_OPTION, ULTRACODE_OPTION];

    const MODEL_CATALOG = {
        v: 1,
        agentId: 'claude',
        updatedAt: 1,
        currentModelId: 'claude-opus-5',
        availableModels: [{
            id: 'claude-opus-5',
            name: 'Opus 5',
            extendedContextModelId: 'claude-opus-5[1m]',
            modelOptions: AUTHORED_OPTIONS,
        }],
    };
    const CONFIG_CATALOG = {
        v: 1,
        agentId: 'claude',
        updatedAt: 1,
        configOptions: AUTHORED_OPTIONS,
    };
    const PUBLISHED_METADATA = {
        path: '/tmp',
        host: 'h',
        acpSessionModelsV1: MODEL_CATALOG,
        sessionModelsV1: MODEL_CATALOG,
        acpConfigOptionsV1: CONFIG_CATALOG,
        sessionConfigOptionsV1: CONFIG_CATALOG,
        sessionConfigOptionOverridesV1: {
            v: 1,
            updatedAt: 2,
            overrides: { ultracode: { updatedAt: 2, value: 'true' } },
        },
    };

    it('is accepted by the producer-side protocol option schema', () => {
        const parsed = AgentModelOptionSchema.safeParse(ULTRACODE_OPTION);
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.overridesWhenOn).toEqual(OVERRIDE_RULE);
    });

    /**
     * The owner-metadata envelope schemas are `.strict()`: an undeclared field does not get
     * stripped, it rejects the ENTIRE owner metadata with `unsupported_owner_metadata`, and
     * `updateSessionMetadataTupleWithRetry` throws on that result instead of degrading.
     */
    it('is accepted and preserved by the strict owner-metadata envelope', () => {
        const created = createSessionOwnerMetadataV1({ metadata: PUBLISHED_METADATA });

        expect(created.ok).toBe(true);
        if (!created.ok) return;
        expect(created.ownerMetadata.runtime?.sessionConfigOptionsV1?.configOptions[1]?.overridesWhenOn)
            .toEqual(OVERRIDE_RULE);
        expect(created.ownerMetadata.runtime?.sessionModelsV1
            ?.availableModels[0]?.modelOptions?.[1]?.overridesWhenOn)
            .toEqual(OVERRIDE_RULE);
    });

    /** `MetadataSchema` is the parse every decrypted session metadata goes through. */
    it('survives the persisted MetadataSchema parse on all four option carriers', () => {
        const metadata = MetadataSchema.parse(JSON.stringify(PUBLISHED_METADATA));

        expect(metadata.acpConfigOptionsV1?.configOptions[1]?.overridesWhenOn).toEqual(OVERRIDE_RULE);
        expect(metadata.sessionConfigOptionsV1?.configOptions[1]?.overridesWhenOn).toEqual(OVERRIDE_RULE);
        expect(metadata.acpSessionModelsV1?.availableModels[0]?.modelOptions?.[1]?.overridesWhenOn)
            .toEqual(OVERRIDE_RULE);
        expect(metadata.sessionModelsV1?.availableModels[0]?.modelOptions?.[1]?.overridesWhenOn)
            .toEqual(OVERRIDE_RULE);
        expect(metadata.acpSessionModelsV1?.availableModels[0]?.extendedContextModelId)
            .toBe('claude-opus-5[1m]');
        expect(metadata.sessionModelsV1?.availableModels[0]?.extendedContextModelId)
            .toBe('claude-opus-5[1m]');
    });

    it('drives the forced display through controls built from the parsed metadata', () => {
        const metadata = MetadataSchema.parse(JSON.stringify(PUBLISHED_METADATA));

        const controls = computeSessionConfigOptionControls({ agentId: 'claude', metadata });
        expect(controls?.find((control) => control.option.id === 'ultracode')?.option.overridesWhenOn)
            .toEqual(OVERRIDE_RULE);
        const effort = controls?.find((control) => control.option.id === 'reasoning_effort');
        expect(effort?.disabled).toBe(true);
        expect(effort?.disabledByOptionName).toBe('Ultracode');
        expect(effort?.overriddenEffectiveValue).toBe('xhigh');
        expect(effort?.effectiveValue).toBe('high');
    });

    it('survives the model-catalog parse into model-scoped controls', () => {
        const metadata = MetadataSchema.parse(JSON.stringify(PUBLISHED_METADATA));
        const parsed = parseSessionModelsState(metadata.sessionModelsV1);

        expect(parsed?.availableModels[0]?.extendedContextModelId).toBe('claude-opus-5[1m]');

        const publishedOptions = parsed?.availableModels[0]?.modelOptions ?? [];
        const controls = computeSessionConfigOptionControlsFromOverride({
            agentId: 'claude',
            configOptions: publishedOptions,
            overrides: { ultracode: { value: 'true' } },
        });

        const effort = controls?.find((control) => control.option.id === 'reasoning_effort');
        expect(effort?.disabled).toBe(true);
        expect(effort?.overriddenEffectiveValue).toBe('xhigh');
    });

    it('survives the free-form config-options normalizer used by the probe caches', () => {
        const metadata = MetadataSchema.parse(JSON.stringify(PUBLISHED_METADATA));
        const normalized = normalizeAcpConfigOptionsArray(metadata.acpConfigOptionsV1?.configOptions);
        const controls = computeSessionConfigOptionControlsFromOverride({
            agentId: 'claude',
            configOptions: normalized,
            overrides: { ultracode: { value: 'true' } },
        });

        const effort = controls?.find((control) => control.option.id === 'reasoning_effort');
        expect(effort?.disabled).toBe(true);
        expect(effort?.overriddenEffectiveValue).toBe('xhigh');
    });
});

/**
 * `normalizeAcpConfigOptionsArray` and the provider control builder take a free-form option array:
 * on those paths nothing else validates the override rule, so the builder's own normalizer IS the
 * validator. It must therefore be the SAME validator the schema path uses, or the UI can hold a
 * rule the strict owner-metadata envelope would refuse to persist.
 */
describe('the override rule has one validator on the free-form option paths', () => {
    const CONTRACT_REJECTED_RULES: ReadonlyArray<readonly [string, unknown]> = [
        ['more option ids than the contract allows', {
            optionIds: Array.from({ length: 40 }, () => 'reasoning_effort'),
        }],
        ['an option id longer than the contract allows', { optionIds: ['a'.repeat(400)] }],
        ['a forced value longer than the contract allows', {
            optionIds: ['reasoning_effort'],
            forcedValue: 'x'.repeat(500),
        }],
        ['an empty option id member', { optionIds: ['reasoning_effort', ''] }],
    ];

    function normalizeUltracodeRule(overridesWhenOn: unknown) {
        return normalizeAcpConfigOptionsArray([{
            id: 'ultracode',
            name: 'Ultracode',
            type: 'boolean',
            currentValue: 'false',
            overridesWhenOn,
        }])?.[0]?.overridesWhenOn;
    }

    it.each(CONTRACT_REJECTED_RULES)('drops a rule the producer contract rejects: %s', (_label, rule) => {
        expect(AgentModelOptionOverrideRuleSchema.safeParse(rule).success).toBe(false);
        expect(normalizeUltracodeRule(rule)).toBeUndefined();
    });

    it('keeps a rule the producer contract accepts', () => {
        expect(normalizeUltracodeRule({ optionIds: ['reasoning_effort'], forcedValue: 'xhigh' }))
            .toEqual({ optionIds: ['reasoning_effort'], forcedValue: 'xhigh' });
    });

    it('strips an unrecognized producer field rather than dropping the whole rule', () => {
        expect(normalizeUltracodeRule({
            optionIds: ['reasoning_effort'],
            forcedValue: 'xhigh',
            futureProducerField: 1,
        })).toEqual({ optionIds: ['reasoning_effort'], forcedValue: 'xhigh' });
    });

    it('applies the same validator to the provider control builder', () => {
        const controls = computeSessionConfigOptionControlsForProvider({
            providerId: 'claude',
            configOptions: [
                {
                    id: 'reasoning_effort',
                    name: 'Thinking',
                    type: 'select',
                    currentValue: 'low',
                    options: [{ value: 'low', name: 'Low' }, { value: 'xhigh', name: 'XHigh' }],
                },
                {
                    id: 'ultracode',
                    name: 'Ultracode',
                    type: 'boolean',
                    currentValue: 'false',
                    overridesWhenOn: { optionIds: ['reasoning_effort', ''] },
                },
            ],
            overrides: { ultracode: { value: 'true' } },
        });

        expect(controls?.find((control) => control.option.id === 'ultracode')?.option.overridesWhenOn)
            .toBeUndefined();
        expect(controls?.find((control) => control.option.id === 'reasoning_effort')?.disabled)
            .toBeUndefined();
    });
});
