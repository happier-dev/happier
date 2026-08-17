import { readFile } from 'node:fs/promises';

import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { definePlugin } from './definePlugin.js';
import * as targetedContributionsHost from './host/targeted-contributions/index.public.js';
import {
    defineProtocolJsonValue,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUtf8String,
} from './protocol/protocolFacade.js';
import {
    defineContributionPoint,
    defineContributionProtocol,
} from './targetedContributionAuthoring.js';
import type { ProtocolComposableSchema } from './protocol/protocolFacade.js';
import type {
    DescriptorFields,
    SchemaInput,
    SchemaOutput,
    TargetedContributionPointSemanticInput,
} from './targetedContributionAuthoring.js';

const emptyResultSchema = defineProtocolObject({}, { policy: 'closed' });

describe('targeted contribution point semantics', () => {
    it('projects the canonical selection root through the neutral composable schema contract', async () => {
        const source = await readFile(
            new URL('./targetedContributionAuthoring.ts', import.meta.url),
            'utf8',
        );

        expect(source).toContain(
            'PluginTargetedContributionSelectionV1Schema: ProtocolComposableSchema<PluginTargetedContributionSelectionV1>',
        );
    });

    it('preserves public composable-schema inference for target descriptors and surface inputs', () => {
        type Descriptor = ProtocolComposableSchema<
            Readonly<{ providerId: string }>,
            Readonly<{ providerId: string }>
        >;
        type SurfaceInput = ProtocolComposableSchema<
            Readonly<{ issueId: string }>,
            Readonly<{ issueId: string }>
        >;

        expectTypeOf<SchemaInput<SurfaceInput>>().toEqualTypeOf<Readonly<{ issueId: string }>>();
        expectTypeOf<SchemaOutput<Descriptor>>().toEqualTypeOf<Readonly<{ providerId: string }>>();
        expectTypeOf<DescriptorFields<Descriptor>>().toEqualTypeOf<Readonly<{
            descriptor?: Readonly<{ providerId: string }>;
        }>>();
    });

    it('derives a point from a symbol-free structural protocol contract', () => {
        const input = defineProtocolObject({
            kind: defineProtocolLiteral('inspect'),
        }, { policy: 'closed' });
        const result = defineProtocolObject({
            accepted: defineProtocolLiteral(true),
        }, { policy: 'closed' });
        const builtInProtocol = defineContributionProtocol({
            id: 'structural-targeted-protocol',
            version: 1,
            operations: {
                inspect: {
                    required: true,
                    input: { kind: 'protocolDefined', schema: input },
                    resultSchema: result,
                    action: { surface: 'plugin', dangerLevel: 'safe' },
                },
            },
        });
        const externalProtocol = {
            id: builtInProtocol.id,
            version: builtInProtocol.version,
            operations: { ...builtInProtocol.operations },
            surfaces: { ...builtInProtocol.surfaces },
        };

        expect(Object.getOwnPropertySymbols(externalProtocol)).toEqual([]);
        const point = defineContributionPoint([externalProtocol]);

        expect(point.protocols).toMatchObject([{
            id: 'structural-targeted-protocol',
            version: 1,
            operations: {
                inspect: {
                    required: true,
                    action: { surface: 'plugin', dangerLevel: 'safe' },
                },
            },
        }]);
    });

    it('projects parser-equivalent byte and safe-integer bounds into targeted descriptor schemas', () => {
        const descriptor = defineProtocolObject({
            title: defineProtocolUtf8String({ maxUtf8Bytes: 4 }),
            payload: defineProtocolJsonValue({ maxSerializedUtf8Bytes: 6 }),
            sequence: defineProtocolNumber({ integer: true }),
        }, { policy: 'closed' });
        const protocol = defineContributionProtocol({
            id: 'bounded-targeted-descriptor',
            version: 1,
            descriptor,
            operations: {},
        });
        const projectedDescriptor = protocol.point().protocols[0]?.descriptor;
        if (!projectedDescriptor) throw new Error('Expected targeted descriptor schema');
        const validates = compilePluginJsonSchema(projectedDescriptor);

        expect(validates({
            title: 'éé',
            payload: 'éé',
            sequence: Number.MAX_SAFE_INTEGER,
        })).toBe(true);
        for (const value of [
            { title: 'ééé', payload: 'éé', sequence: 1 },
            { title: 'éé', payload: 'ééé', sequence: 1 },
            { title: 'éé', payload: 'éé', sequence: Number.MAX_SAFE_INTEGER + 1 },
        ]) {
            expect(descriptor.safeParse(value).success).toBe(false);
            expect(validates(value)).toBe(false);
        }
    });

    it('projects the live target descriptor and declared surfaces without serializing executable semantics', () => {
        const descriptor = defineProtocolObject({
            providerId: defineProtocolString(),
        }, { policy: 'closed' });
        const detail = defineProtocolObject({
            issueId: defineProtocolString(),
        }, { policy: 'closed' });
        const protocol = defineContributionProtocol({
            id: 'triage-source',
            version: 1,
            descriptor,
            operations: {
                inspect: {
                    required: true,
                    input: { kind: 'contributorDefined' },
                    resultSchema: emptyResultSchema,
                    action: { surface: 'plugin', dangerLevel: 'safe' },
                },
            },
            surfaces: {
                detail: {
                    required: true,
                    inputSchema: detail,
                    presentation: 'content',
                },
                preview: {
                    required: false,
                    inputSchema: detail,
                    presentation: 'fill',
                },
            },
        });
        const target = definePlugin({
            id: 'happier.triage',
            version: '0.1.0',
            contributionPoints: { sources: protocol.point() },
        });
        const decoder = targetedContributionsHost.decodeTargetedContributionPointSemantics;
        expect(Object.keys(targetedContributionsHost)).toEqual([
            'decodeTargetedContributionPointSemantics',
            'readTargetedContributionPointSemanticRefs',
        ]);

        const point = target.contributionPoints.sources;
        const semanticPointRefs = targetedContributionsHost
            .readTargetedContributionPointSemanticRefs(target.manifest);
        expect(semanticPointRefs).toHaveLength(1);
        expect(semanticPointRefs[0]).toBe(point);
        const targetPointCollection = target.manifest.contributes.pluginContributionPoints;
        const semanticRefsKey = Object.getOwnPropertySymbols(targetPointCollection)[0];
        if (!semanticRefsKey) throw new Error('Expected manifest semantic-ref sidecar');
        expect(Object.getOwnPropertyDescriptor(targetPointCollection, semanticRefsKey)?.enumerable).toBe(false);
        expect(JSON.stringify(targetPointCollection)).toBe(JSON.stringify([...targetPointCollection]));
        const result = decoder(point, {
            protocol: point.protocol,
            descriptor: { providerId: 'github' },
            operations: [{ role: 'inspect' }],
            surfaces: [
                { role: 'detail', presentation: 'content' },
                { role: 'future-optional-role', presentation: 'future-presentation' },
            ],
        });

        if (!result.ok) throw new TypeError('Expected target semantic projection');
        const projection = result.projection;

        expect(projection.descriptor).toEqual({ providerId: 'github' });
        expect(projection.operations).toEqual([{
            role: 'inspect',
            input: { kind: 'contributorDefined' },
            resultSchema: emptyResultSchema,
        }]);
        expect(projection.surfaces).toEqual([{ role: 'detail', presentation: 'content' }]);
        expect(Object.isFrozen(projection)).toBe(true);
        expect(Object.isFrozen(projection.operations)).toBe(true);
        expect(Object.isFrozen(projection.operations[0])).toBe(true);
        expect(Object.isFrozen(projection.surfaces)).toBe(true);
        expect(Object.isFrozen(projection.surfaces[0])).toBe(true);
        expect(Object.keys(point)).toEqual(['targetPluginId', 'id', 'protocol']);
        expect(JSON.stringify(point)).toBe(JSON.stringify({
            targetPluginId: 'happier.triage',
            id: 'sources',
            protocol: { id: 'triage-source', version: 1 },
        }));

        // The carrier comes only from the SDK-produced live point. A copied
        // public shape cannot reconstruct target parser semantics.
        const carrierlessPoint = { ...point };
        expect(decoder(carrierlessPoint, {
            protocol: point.protocol,
            descriptor: { providerId: 'github' },
            operations: [{ role: 'inspect' }],
            surfaces: [{ role: 'detail', presentation: 'content' }],
        })).toEqual({ ok: false, code: 'target_semantics_unavailable' });
    });

    it('classifies a carrier that disagrees with its visible target point as unavailable target semantics', () => {
        const descriptor = defineProtocolObject({
            providerId: defineProtocolString(),
        }, { policy: 'closed' });
        const detail = defineProtocolObject({
            issueId: defineProtocolString(),
        }, { policy: 'closed' });
        const v1 = defineContributionProtocol({
            id: 'triage-source',
            version: 1,
            descriptor,
            operations: {},
            surfaces: {
                detail: { required: true, inputSchema: detail, presentation: 'content' },
            },
        });
        const v2 = defineContributionProtocol({
            id: 'triage-source',
            version: 2,
            descriptor,
            operations: {},
            surfaces: {
                detail: { required: true, inputSchema: detail, presentation: 'content' },
            },
        });
        const target = definePlugin({
            id: 'happier.triage',
            version: '0.1.0',
            contributionPoints: {
                sources: defineContributionPoint([v1, v2]),
            },
        });
        const v1Point = target.contributionPoints.sources.protocols[0]!;
        const v2Point = target.contributionPoints.sources.protocols[1]!;
        const carrierKey = Object.getOwnPropertySymbols(v1Point)[0];
        if (!carrierKey) throw new Error('Expected target point semantic carrier');
        const carrier = Object.getOwnPropertyDescriptor(v1Point, carrierKey);
        if (!carrier) throw new Error('Expected target point semantic carrier descriptor');
        const visibleV2PointWithV1Carrier = Object.freeze(Object.defineProperty({
            targetPluginId: v2Point.targetPluginId,
            id: v2Point.id,
            protocol: v2Point.protocol,
        }, carrierKey, carrier));

        expect(targetedContributionsHost.decodeTargetedContributionPointSemantics(
            visibleV2PointWithV1Carrier,
            {
                protocol: v2Point.protocol,
                descriptor: { providerId: 'github' },
                operations: [],
                surfaces: [{ role: 'detail', presentation: 'content' }],
            },
        )).toEqual({ ok: false, code: 'target_semantics_unavailable' });
    });

    it('rejects incompatible semantic input without giving unknown roles authority', () => {
        const descriptor = defineProtocolObject({
            providerId: defineProtocolString(),
        }, { policy: 'closed' });
        const detail = defineProtocolObject({
            issueId: defineProtocolString(),
        }, { policy: 'closed' });
        const protocol = defineContributionProtocol({
            id: 'triage-source',
            version: 1,
            descriptor,
            operations: {},
            surfaces: {
                detail: {
                    required: true,
                    inputSchema: detail,
                    presentation: 'content',
                },
            },
        });
        const target = definePlugin({
            id: 'happier.triage',
            version: '0.1.0',
            contributionPoints: { sources: protocol.point() },
        });
        const decoder = targetedContributionsHost.decodeTargetedContributionPointSemantics;

        const point = target.contributionPoints.sources;
        const valid: TargetedContributionPointSemanticInput = {
            protocol: point.protocol,
            descriptor: { providerId: 'github' },
            operations: [],
            surfaces: [{ role: 'detail', presentation: 'content' }],
        };
        expect(decoder(point, {
            ...valid,
            descriptor: { providerId: 42 },
        })).toEqual({ ok: false, code: 'descriptor_semantic_invalid' });
        expect(decoder(point, {
            ...valid,
            surfaces: [],
        })).toEqual({ ok: false, code: 'surface_semantic_invalid' });
        expect(decoder(point, {
            ...valid,
            surfaces: [
                { role: 'detail', presentation: 'content' },
                { role: 'detail', presentation: 'content' },
            ],
        })).toEqual({ ok: false, code: 'surface_semantic_invalid' });
        expect(decoder(point, {
            ...valid,
            surfaces: [{ role: 'detail', presentation: 'fill' }],
        })).toEqual({ ok: false, code: 'surface_semantic_invalid' });
        expect(decoder(point, {
            ...valid,
            protocol: { id: 'triage-source', version: 2 },
        })).toEqual({ ok: false, code: 'point_reference_invalid' });

    });

    it('rejects malformed target and contributor surface roles before projecting declarations', () => {
        const detail = defineProtocolObject({
            issueId: defineProtocolString(),
        }, { policy: 'closed' });
        const surface = {
            required: true,
            inputSchema: detail,
            presentation: 'content' as const,
        };

        const protocol = defineContributionProtocol({
            id: 'triage-source',
            version: 1,
            operations: {},
            surfaces: { detail: surface },
        });
        expect(protocol.point().protocols[0]?.surfaces).toHaveProperty('detail');
        const contribute = Reflect.get(protocol, 'contribute');
        if (typeof contribute !== 'function') throw new Error('Contribution protocol must expose contribute');
        expect(Reflect.apply(contribute, protocol, [{
            operations: {},
            surfaces: { detail: { renderer: 'detail-renderer' } },
        }]).surfaces).toEqual({
            detail: { renderer: 'detail-renderer' },
        });

        for (const role of ['detail View', 'detail\\View', '../detail', 'Detail']) {
            expect(() => defineContributionProtocol({
                id: 'triage-source',
                version: 1,
                operations: {},
                surfaces: { [role]: surface },
            }), role).toThrow();
            expect(() => Reflect.apply(contribute, protocol, [{
                operations: {},
                surfaces: { [role]: { renderer: 'detail-renderer' } },
            }]), role).toThrow();
        }
    });

    it('consumes a complete cross-copy carrier by its semantic facts rather than object topology', () => {
        const descriptor = defineProtocolObject({
            providerId: defineProtocolString(),
        }, { policy: 'closed' });
        const point = {
            targetPluginId: 'happier.triage',
            id: 'sources',
            protocol: { id: 'triage-source', version: 1 },
        };
        Object.setPrototypeOf(point, null);
        const carrier = {
            kind: 'happier.pluginSdk.targetedContributionPointSemantics',
            version: 1,
            targetPluginId: 'happier.triage',
            id: 'sources',
            protocol: { id: 'triage-source', version: 1 },
            descriptor,
            operations: {},
            surfaces: {
                detail: { required: true, presentation: 'content' },
            },
        };
        Object.setPrototypeOf(carrier, null);
        Object.setPrototypeOf(carrier.surfaces, null);
        Object.defineProperty(
            point,
            Symbol.for('happier.pluginSdk.targetedContributionPointSemantics.v1'),
            { value: carrier },
        );

        expect(Object.isFrozen(point)).toBe(false);
        expect(Object.isFrozen(carrier)).toBe(false);
        expect(targetedContributionsHost.decodeTargetedContributionPointSemantics(
            point,
            {
                protocol: { id: 'triage-source', version: 1 },
                descriptor: { providerId: 'github' },
                operations: [],
                surfaces: [{ role: 'detail', presentation: 'content' }],
            },
        )).toEqual({
            ok: true,
            projection: {
                descriptor: { providerId: 'github' },
                operations: [],
                surfaces: [{ role: 'detail', presentation: 'content' }],
            },
        });

        const malformedCarrierPoint = {
            targetPluginId: 'happier.triage',
            id: 'sources',
            protocol: { id: 'triage-source', version: 1 },
        };
        Object.defineProperty(
            malformedCarrierPoint,
            Symbol.for('happier.pluginSdk.targetedContributionPointSemantics.v1'),
            {
                value: {
                    ...carrier,
                    surfaces: {
                        'detail View': { required: true, presentation: 'content' },
                    },
                },
            },
        );

        expect(targetedContributionsHost.decodeTargetedContributionPointSemantics(
            malformedCarrierPoint,
            {
                protocol: { id: 'triage-source', version: 1 },
                descriptor: { providerId: 'github' },
                operations: [],
                surfaces: [{ role: 'detail View', presentation: 'content' }],
            },
        )).toEqual({ ok: false, code: 'target_semantics_unavailable' });
    });

    it('does not retain accessor-error policy around a trusted semantic carrier', () => {
        const point = {
            targetPluginId: 'happier.triage',
            id: 'sources',
            protocol: { id: 'triage-source', version: 1 },
        };
        Object.defineProperty(
            point,
            Symbol.for('happier.pluginSdk.targetedContributionPointSemantics.v1'),
            {
                get() {
                    throw new Error('trusted carrier accessor failed');
                },
            },
        );

        expect(() => targetedContributionsHost.decodeTargetedContributionPointSemantics(
            point,
            {
                protocol: point.protocol,
                operations: [],
                surfaces: [],
            },
        )).toThrow('trusted carrier accessor failed');
    });

    it('keeps each accepted protocol epoch on its own live point ref', () => {
        const v1Descriptor = defineProtocolObject({
            providerId: defineProtocolString(),
        }, { policy: 'closed' });
        const v2Descriptor = defineProtocolObject({
            integrationId: defineProtocolString(),
        }, { policy: 'closed' });
        const surface = defineProtocolObject({
            id: defineProtocolString(),
        }, { policy: 'closed' });
        const v1 = defineContributionProtocol({
            id: 'triage-source',
            version: 1,
            descriptor: v1Descriptor,
            operations: {},
            surfaces: {
                detail: { required: true, inputSchema: surface, presentation: 'content' },
            },
        });
        const v2 = defineContributionProtocol({
            id: 'triage-source',
            version: 2,
            descriptor: v2Descriptor,
            operations: {},
            surfaces: {
                preview: { required: true, inputSchema: surface, presentation: 'fill' },
            },
        });
        const target = definePlugin({
            id: 'happier.triage',
            version: '0.1.0',
            contributionPoints: {
                sources: defineContributionPoint([v1, v2]),
            },
        });
        const v2Point = target.contributionPoints.sources.protocols[1];

        expect(targetedContributionsHost.decodeTargetedContributionPointSemantics(v2Point, {
            protocol: v2Point.protocol,
            descriptor: { integrationId: 'linear' },
            operations: [],
            surfaces: [{ role: 'preview', presentation: 'fill' }],
        })).toEqual({
            ok: true,
            projection: {
                descriptor: { integrationId: 'linear' },
                operations: [],
                surfaces: [{ role: 'preview', presentation: 'fill' }],
            },
        });
        expect(targetedContributionsHost.decodeTargetedContributionPointSemantics(v2Point, {
            protocol: v2Point.protocol,
            descriptor: { providerId: 'github' },
            operations: [],
            surfaces: [{ role: 'detail', presentation: 'content' }],
        })).toEqual({ ok: false, code: 'descriptor_semantic_invalid' });
    });
});
