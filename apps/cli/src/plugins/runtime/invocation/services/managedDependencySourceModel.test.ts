import { describe, expect, it } from 'vitest';

import type { ResolvedInstallableContribution } from '@/plugins/projection/registry/types';

import { createV2ManagedDependencySourceModel } from './managedDependencySourceModel';

const declarationBytes = (definition: unknown): number => new TextEncoder().encode(JSON.stringify(definition)).byteLength;

const sourceSpec = {
    kind: 'path' as const,
    locator: '/plugins/acme',
    trustPolicy: 'local_trusted' as const,
    installPolicy: 'link' as const,
};

function contribution(
    pluginId: string,
    localId: string,
    overrides: Partial<Extract<ResolvedInstallableContribution['definition'], { sources: unknown }>> = {},
): ResolvedInstallableContribution {
    return {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId,
        manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
        daemonEntryPath: null,
        sourceSpec,
        definition: {
            id: localId,
            title: `${pluginId} tool`,
            sources: [
                { kind: 'manual', instructions: `Install ${localId}` },
                { kind: 'system', executableNames: [localId], versionArguments: ['--version'] },
            ],
            platforms: ['macos', 'linux'],
            architectures: ['arm64'],
            executable: localId,
            ...overrides,
        },
    };
}

describe('V2 managed dependency source model', () => {
    it('owns retirement on the direct model instance without a registry-wide identity', () => {
        const currentContribution = contribution('acme.one', 'tool');
        const model = createV2ManagedDependencySourceModel({
            platform: 'linux',
            architecture: 'arm64',
            contributions: [currentContribution],
        });

        expect(model.resolve({ pluginId: 'acme.one', localId: 'tool' }).definition)
            .toBe(currentContribution.definition);
        expect(model).not.toHaveProperty('generationId');
        expect(model.snapshot()).not.toHaveProperty('generationId');

        model.retire();
        expect(() => model.resolve({ pluginId: 'acme.one', localId: 'tool' }))
            .toThrowError(expect.objectContaining({ code: 'plugin_managed_dependency_generation_retired' }));
    });

    it('requires complete canonical provenance without accepting a registry-wide identity', () => {
        expect(() => createV2ManagedDependencySourceModel({
            platform: 'linux', architecture: 'arm64',
            contributions: [{
                ...contribution('acme.one', 'tool'),
                sourceSpec: { ...sourceSpec, kind: 'archive' },
            }],
        })).toThrowError(expect.objectContaining({ code: 'plugin_managed_dependency_source_invalid' }));
    });

    it('keeps source-acquisition integrity out of the retained dependency authority', () => {
        const { ...withoutSourceAcquisitionDigest } = contribution(
            'acme.one',
            'tool',
        );

        const model = createV2ManagedDependencySourceModel({
            platform: 'linux',
            architecture: 'arm64',
            contributions: [withoutSourceAcquisitionDigest],
        });

        expect(model.resolve({ pluginId: 'acme.one', localId: 'tool' }))
            .not.toHaveProperty('manifestDigest');
    });

    it('rejects unknown host platforms and invalid host architecture identities', () => {
        expect(() => createV2ManagedDependencySourceModel({
            platform: 'solaris' as 'linux', architecture: 'x64', contributions: [],
        })).toThrowError(expect.objectContaining({ code: 'plugin_managed_dependency_source_invalid' }));
        expect(() => createV2ManagedDependencySourceModel({
            platform: 'linux', architecture: ' ', contributions: [],
        })).toThrowError(expect.objectContaining({ code: 'plugin_managed_dependency_source_invalid' }));
        expect(() => createV2ManagedDependencySourceModel({
            platform: 'linux', architecture: 'x'.repeat(65), contributions: [],
        })).toThrowError(expect.objectContaining({ code: 'plugin_managed_dependency_source_invalid' }));
    });

    it('fails closed instead of silently dropping an invalid non-legacy dependency shape', () => {
        const malformed = {
            ...contribution('acme.one', 'tool'),
            definition: { id: 'tool', title: 'Tool', executable: 'tool' },
        } as unknown as ResolvedInstallableContribution;

        expect(() => createV2ManagedDependencySourceModel({
            platform: 'linux', architecture: 'arm64',
            contributions: [malformed],
        })).toThrowError(expect.objectContaining({ code: 'plugin_managed_dependency_source_invalid' }));
    });

    it('preserves qualified source identity and keeps system-first selection deterministic', () => {
        const model = createV2ManagedDependencySourceModel({
            platform: 'darwin',
            architecture: 'arm64',
            contributions: [
                contribution('acme.one', 'tool'),
                contribution('acme.two', 'tool'),
            ],
        });

        expect(model.snapshot().dependencies.map((dependency) => dependency.qualifiedId)).toEqual([
            'acme.one/tool',
            'acme.two/tool',
        ]);
        expect(model.resolve({ pluginId: 'acme.one', localId: 'tool' })).toMatchObject({
            identity: { pluginId: 'acme.one', localId: 'tool' },
            pluginSource: { kind: 'path', locator: '/plugins/acme' },
            availability: { state: 'available' },
            sources: [
                { sourceId: 'acme.one/tool#1', kind: 'system', version: null, updatePolicy: 'external', disposition: 'executable' },
                { sourceId: 'acme.one/tool#0', kind: 'manual', version: null, updatePolicy: 'manual', disposition: 'manual' },
            ],
        });
    });

    it('keeps external and manual update ownership distinct', () => {
        const model = createV2ManagedDependencySourceModel({
            platform: 'linux', architecture: 'arm64',
            contributions: [contribution('acme.one', 'tool', {
                sources: [
                    { kind: 'vendorRecipe', recipeId: 'vendor.tool' },
                    { kind: 'manual', instructions: 'Install Tool' },
                    { kind: 'system', executableNames: ['tool'] },
                ],
            })],
        });

        expect(model.resolve({ pluginId: 'acme.one', localId: 'tool' }).sources.map((source) => [
            source.kind, source.updatePolicy, source.disposition,
        ])).toEqual([
            ['system', 'external', 'executable'],
            ['vendorRecipe', 'manual', 'manual'],
            ['manual', 'manual', 'manual'],
        ]);
    });

    it('fails closed on duplicate qualified identity instead of selecting one declaration', () => {
        expect(() => createV2ManagedDependencySourceModel({
            platform: 'linux',
            architecture: 'x64',
            contributions: [contribution('acme.one', 'tool'), contribution('acme.one', 'tool')],
        })).toThrowError(expect.objectContaining({ code: 'plugin_managed_dependency_identity_conflict' }));
    });

    it('projects platform and architecture mismatch as explicit unavailability', () => {
        const model = createV2ManagedDependencySourceModel({
            platform: 'win32',
            architecture: 'x64',
            contributions: [contribution('acme.one', 'tool')],
        });

        expect(model.resolve({ pluginId: 'acme.one', localId: 'tool' }).availability).toEqual({
            state: 'unavailable',
            code: 'plugin_managed_dependency_platform_unsupported',
        });
    });

    it('enforces the aggregate dependency bound before publication', () => {
        const exact = createV2ManagedDependencySourceModel({
            platform: 'linux',
            architecture: 'x64',
            contributions: Array.from({ length: 128 }, (_, index) => contribution(`acme.plugin-${index}`, 'tool')),
        });
        expect(exact.snapshot().dependencies).toHaveLength(128);

        expect(() => createV2ManagedDependencySourceModel({
            platform: 'linux',
            architecture: 'x64',
            contributions: Array.from({ length: 129 }, (_, index) => contribution(`acme.plugin-${index}`, 'tool')),
        })).toThrowError(expect.objectContaining({ code: 'plugin_managed_dependency_capacity_exceeded' }));
    });

    it('enforces the per-dependency source bound before publication', () => {
        const exact = createV2ManagedDependencySourceModel({
            platform: 'linux', architecture: 'x64',
            contributions: [contribution('acme.one', 'tool', {
                sources: Array.from({ length: 8 }, (_, index) => ({ kind: 'system' as const, executableNames: [`tool-${index}`] })),
            })],
        });
        expect(exact.resolve({ pluginId: 'acme.one', localId: 'tool' }).sources).toHaveLength(8);

        expect(() => createV2ManagedDependencySourceModel({
            platform: 'linux', architecture: 'x64',
            contributions: [contribution('acme.one', 'tool', {
                sources: Array.from({ length: 9 }, (_, index) => ({ kind: 'system' as const, executableNames: [`tool-${index}`] })),
            })],
        })).toThrowError(expect.objectContaining({ code: 'plugin_managed_dependency_source_capacity_exceeded' }));
    });

    it('bounds duplicate platform and architecture declarations before publication', () => {
        expect(() => createV2ManagedDependencySourceModel({
            platform: 'linux', architecture: 'x64',
            contributions: [contribution('acme.one', 'tool', {
                platforms: ['linux', 'linux'],
            })],
        })).toThrowError(expect.objectContaining({ code: 'plugin_managed_dependency_source_invalid' }));

        expect(() => createV2ManagedDependencySourceModel({
            platform: 'linux', architecture: 'x64',
            contributions: [contribution('acme.one', 'tool', {
                architectures: Array.from({ length: 17 }, (_, index) => `arch-${index}`),
            })],
        })).toThrowError(expect.objectContaining({ code: 'plugin_managed_dependency_source_invalid' }));

    });

    it('rejects an oversized declaration before source publication', () => {
        expect(() => createV2ManagedDependencySourceModel({
            platform: 'linux', architecture: 'x64',
            contributions: [contribution('acme.one', 'tool', {
                sources: [{ kind: 'manual', instructions: 'x'.repeat(70_000) }],
            })],
        })).toThrowError(expect.objectContaining({ code: 'plugin_managed_dependency_source_invalid' }));
    });

    it('accepts the exact declaration byte bound and rejects one byte beyond it', () => {
        const definition = contribution('acme.one', 'tool', { metadata: { padding: '' } }).definition;
        const paddingBytes = (64 * 1024) - declarationBytes(definition);
        const exactDefinition = { ...definition, metadata: { padding: 'x'.repeat(paddingBytes) } };
        const overDefinition = { ...exactDefinition, metadata: { padding: `${exactDefinition.metadata.padding}x` } };
        expect(declarationBytes(exactDefinition)).toBe(64 * 1024);
        expect(declarationBytes(overDefinition)).toBe((64 * 1024) + 1);

        const exact = createV2ManagedDependencySourceModel({
            platform: 'linux', architecture: 'arm64',
            contributions: [{ ...contribution('acme.one', 'tool'), definition: exactDefinition }],
        });
        expect(exact.snapshot().dependencies).toHaveLength(1);
        expect(() => createV2ManagedDependencySourceModel({
            platform: 'linux', architecture: 'arm64',
            contributions: [{ ...contribution('acme.one', 'tool'), definition: overDefinition }],
        })).toThrowError(expect.objectContaining({ code: 'plugin_managed_dependency_source_invalid' }));
    });

    it('fences every lookup after the model retires', () => {
        const model = createV2ManagedDependencySourceModel({
            platform: 'linux',
            architecture: 'arm64',
            contributions: [contribution('acme.one', 'tool')],
        });

        model.retire();
        expect(() => model.resolve({ pluginId: 'acme.one', localId: 'tool' }))
            .toThrowError(expect.objectContaining({ code: 'plugin_managed_dependency_generation_retired' }));
    });

    it('does not expose a synthetic generation-specific retirement method', () => {
        const model = createV2ManagedDependencySourceModel({
            platform: 'linux', architecture: 'arm64',
            contributions: [contribution('acme.one', 'tool')],
        });

        expect(model).not.toHaveProperty('retireGeneration');
    });
});
