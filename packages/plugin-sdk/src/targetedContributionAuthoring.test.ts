import { readFile } from 'node:fs/promises';

import {
    PluginContributionPointProtocolV1Schema,
    rehydratePluginContributionPointSemanticsV1,
} from '@happier-dev/protocol';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { PLUGIN_UI_TARGETED_CONTRIBUTION_PROTOCOLS_MAX_V1 } from '@happier-dev/protocol/plugins/ui/targetedContributions';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { definePlugin } from './definePlugin.js';
import { parsePluginManifest } from './manifest.js';
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
    ContributionPointAuthorDefinition,
    DescriptorFields,
    SchemaInput,
    SchemaOutput,
} from './targetedContributionAuthoring.js';

const emptyResultSchema = defineProtocolObject({}, { policy: 'closed' });

function readManifestProtocol(
    plugin: Readonly<{
        manifest: Readonly<{
            contributes: Readonly<{
                pluginContributionPoints?: readonly unknown[];
            }>;
        }>;
    }>,
    version: number,
) {
    const point = plugin.manifest.contributes.pluginContributionPoints?.[0];
    const protocols = typeof point === 'object'
        && point !== null
        && 'protocols' in point
        && Array.isArray(point.protocols)
        ? point.protocols
        : [];
    const protocol = protocols.find((candidate) => (
        typeof candidate === 'object'
        && candidate !== null
        && 'version' in candidate
        && candidate.version === version
    ));
    const admitted = PluginContributionPointProtocolV1Schema.safeParse(protocol);
    if (!admitted.success) throw new Error(`Expected manifest protocol epoch ${version}`);
    return admitted.data;
}

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

    it('uses Protocol\'s accepted protocol-epoch ceiling instead of a private literal', async () => {
        const source = await readFile(
            new URL('./targetedContributionAuthoring.ts', import.meta.url),
            'utf8',
        );

        expect(PLUGIN_UI_TARGETED_CONTRIBUTION_PROTOCOLS_MAX_V1).toBe(4);
        expect(source).toContain('PLUGIN_UI_TARGETED_CONTRIBUTION_PROTOCOLS_MAX_V1');
        expect(source).not.toContain('protocols.length > 4');
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
            descriptor: Readonly<{ providerId: string }>;
        }>>();
        expectTypeOf<DescriptorFields<undefined>>().toEqualTypeOf<Readonly<{
            descriptor?: never;
        }>>();
        expectTypeOf<ContributionPointAuthorDefinition<readonly unknown[]>>().not.toHaveProperty('semanticCarrier');
    });

    it('derives a point from a symbol-free structural protocol contract', () => {
        const input = defineProtocolObject({ kind: defineProtocolLiteral('inspect') }, { policy: 'closed' });
        const result = defineProtocolObject({ accepted: defineProtocolLiteral(true) }, { policy: 'closed' });
        const builtInProtocol = defineContributionProtocol({
            id: 'structural-targeted-protocol',
            version: 1,
            operations: {
                inspect: {
                    required: true,
                    input: { kind: 'protocolDefined', schema: input },
                    resultSchema: result,
                    action: { surfaces: ['plugin', 'ui', 'voice'], dangerLevel: 'safe' },
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
        expect(defineContributionPoint([externalProtocol]).protocols).toMatchObject([{
            id: 'structural-targeted-protocol',
            version: 1,
            operations: {
                inspect: {
                    required: true,
                    action: { surfaces: ['plugin', 'ui', 'voice'], dangerLevel: 'safe' },
                },
            },
        }]);
        expect(builtInProtocol.operations.inspect.declaration.surfaces).toEqual(['plugin', 'ui', 'voice']);
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

        expect(validates({ title: 'éé', payload: 'éé', sequence: Number.MAX_SAFE_INTEGER })).toBe(true);
        for (const value of [
            { title: 'ééé', payload: 'éé', sequence: 1 },
            { title: 'éé', payload: 'ééé', sequence: 1 },
            { title: 'éé', payload: 'éé', sequence: Number.MAX_SAFE_INTEGER + 1 },
        ]) {
            expect(descriptor.safeParse(value).success).toBe(false);
            expect(validates(value)).toBe(false);
        }
    });

    it('refuses a contribution that omits or invents a descriptor its protocol did not declare', () => {
        const descriptorProtocol = defineContributionProtocol({
            id: 'descriptor-required-protocol',
            version: 1,
            descriptor: defineProtocolObject({ providerId: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' }),
            operations: {},
        });
        const descriptorFreeProtocol = defineContributionProtocol({
            id: 'descriptor-free-protocol',
            version: 1,
            operations: {},
        });

        expect(() => descriptorProtocol.contribute({
            operations: {},
        } as Parameters<typeof descriptorProtocol.contribute>[0])).toThrow(/requires a descriptor/u);
        expect(descriptorProtocol.contribute({ descriptor: { providerId: 'github' }, operations: {} }))
            .toMatchObject({ descriptor: { providerId: 'github' } });
        expect(() => descriptorFreeProtocol.contribute({
            // @ts-expect-error A descriptor-free protocol forbids the field.
            descriptor: { providerId: 'github' },
            operations: {},
        })).toThrow(/does not declare a descriptor schema/u);
    });

    it('accepts a hand-written structural contribution point declaration', () => {
        const protocol = defineContributionProtocol({
            id: 'triage-source',
            version: 1,
            operations: {
                inspect: {
                    required: true,
                    input: { kind: 'contributorDefined' },
                    resultSchema: emptyResultSchema,
                    action: { surfaces: ['plugin'], dangerLevel: 'safe' },
                },
            },
        });
        const handWritten: ContributionPointAuthorDefinition<readonly unknown[]> = {
            protocols: protocol.point().protocols,
        };

        expect(() => definePlugin({
            id: 'happier.triage',
            version: '0.1.0',
            contributionPoints: { sources: handWritten },
        })).not.toThrow();
    });

    it('rehydrates carrierless target semantics from the exact cold manifest protocol', () => {
        const descriptor = defineProtocolObject({ providerId: defineProtocolString() }, { policy: 'closed' });
        const detail = defineProtocolObject({ issueId: defineProtocolString() }, { policy: 'closed' });
        const protocol = defineContributionProtocol({
            id: 'triage-source',
            version: 1,
            descriptor,
            operations: {
                inspect: {
                    required: true,
                    input: { kind: 'contributorDefined' },
                    resultSchema: emptyResultSchema,
                    action: { surfaces: ['plugin'], dangerLevel: 'safe' },
                },
            },
            surfaces: {
                detail: { required: true, inputSchema: detail, presentation: 'content' },
            },
        });
        const target = definePlugin({
            id: 'happier.triage',
            version: '0.1.0',
            contributionPoints: { sources: protocol.point() },
        });
        const point = target.contributionPoints.sources;
        const coldProtocol = readManifestProtocol(target, 1);
        const semantics = rehydratePluginContributionPointSemanticsV1(coldProtocol);
        if (!semantics || !semantics.descriptor) throw new Error('Expected canonical cold semantics');

        expect(Object.keys(point)).toEqual(['targetPluginId', 'id', 'protocol']);
        expect(Object.keys(target.manifest.contributes.pluginContributionPoints?.[0] ?? {}).sort())
            .toEqual(['id', 'protocols']);
        expect(semantics.descriptor.safeParse({ providerId: 'github' }).success).toBe(true);
        expect(semantics.descriptor.safeParse({ providerId: 42 }).success).toBe(false);
        expect(semantics.operations.map(({ role, input }) => ({ role, input }))).toEqual([
            { role: 'inspect', input: { kind: 'contributorDefined' } },
        ]);
        expect(semantics.surfaces.map(({ role, presentation }) => ({ role, presentation }))).toEqual([
            { role: 'detail', presentation: 'content' },
        ]);
        expect(semantics.surfaces[0]?.inputSchema.safeParse({ issueId: 'issue-1' }).success).toBe(true);
        expect(semantics.surfaces[0]?.inputSchema.safeParse({ issueId: 42 }).success).toBe(false);
        expect(Object.isFrozen(semantics)).toBe(true);
    });

    it('keeps each protocol epoch rehydrated from its own manifest declaration', () => {
        const surface = defineProtocolObject({ id: defineProtocolString() }, { policy: 'closed' });
        const v1 = defineContributionProtocol({
            id: 'triage-source',
            version: 1,
            descriptor: defineProtocolObject({ providerId: defineProtocolString() }, { policy: 'closed' }),
            operations: {},
            surfaces: { detail: { required: true, inputSchema: surface, presentation: 'content' } },
        });
        const v2 = defineContributionProtocol({
            id: 'triage-source',
            version: 2,
            descriptor: defineProtocolObject({ integrationId: defineProtocolString() }, { policy: 'closed' }),
            operations: {},
            surfaces: { preview: { required: true, inputSchema: surface, presentation: 'fill' } },
        });
        const target = definePlugin({
            id: 'happier.triage',
            version: '0.1.0',
            contributionPoints: { sources: defineContributionPoint([v1, v2]) },
        });
        const v2Semantics = rehydratePluginContributionPointSemanticsV1(readManifestProtocol(target, 2));
        if (!v2Semantics || !v2Semantics.descriptor) throw new Error('Expected V2 cold semantics');

        const refs = target.contributionPoints.sources.protocols;
        expect([refs[0]!.protocol, refs[1]!.protocol]).toEqual([
            { id: 'triage-source', version: 1 },
            { id: 'triage-source', version: 2 },
        ]);
        expect(v2Semantics.descriptor.safeParse({ integrationId: 'linear' }).success).toBe(true);
        expect(v2Semantics.descriptor.safeParse({ providerId: 'github' }).success).toBe(false);
        expect(v2Semantics.surfaces.map(({ role, presentation }) => ({ role, presentation }))).toEqual([
            { role: 'preview', presentation: 'fill' },
        ]);
        expect(v2Semantics.surfaces[0]?.inputSchema.safeParse({ id: 'issue-1' }).success).toBe(true);
        expect(v2Semantics.surfaces[0]?.inputSchema.safeParse({ id: 42 }).success).toBe(false);
    });

    it('rejects malformed target and contributor surface roles before projecting declarations', () => {
        const detail = defineProtocolObject({ issueId: defineProtocolString() }, { policy: 'closed' });
        const surface = { required: true, inputSchema: detail, presentation: 'content' as const };
        const protocol = defineContributionProtocol({
            id: 'triage-source',
            version: 1,
            operations: {},
            surfaces: { detail: surface },
        });
        const contribute = Reflect.get(protocol, 'contribute');
        if (typeof contribute !== 'function') throw new Error('Contribution protocol must expose contribute');

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
});
