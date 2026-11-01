import { describe, expect, it } from 'vitest';

import type { ResolvedInstallableContribution } from '@/plugins/projection/registry/types';
import { PluginManagedDependencyContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/managedDependencies';

import { createV2ManagedDependencySourceModel } from './managedDependencySourceModel';

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
    it('projects a pinned archive as the managed immutable version for the selected platform', () => {
        const model = createV2ManagedDependencySourceModel({
            platform: 'linux', architecture: 'x64',
            contributions: [contribution('acme.one', 'tool', { architectures: ['x64'], sources: [{
                kind: 'pinnedArchive', installId: 'dep.acme.tool', version: '1.1.1', assetsByPlatform: {
                    'linux-x64': {
                        archiveUrl: 'https://downloads.example.test/tool-1.1.1.zip', sha256: 'a'.repeat(64),
                        executableSubpath: 'bin/tool', args: ['--platform-default'],
                    },
                },
            }] })],
        });
        expect(model.resolve({ pluginId: 'acme.one', localId: 'tool' }).sources).toEqual([
            expect.objectContaining({ kind: 'pinnedArchive', version: '1.1.1', updatePolicy: 'managed', disposition: 'executable' }),
        ]);
    });

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

    it('projects canonical admitted declarations without a second count or byte policy', () => {
        const instructions = 'x'.repeat(70_000);
        const contributions = Array.from({ length: 129 }, (_, index) => contribution(`acme.plugin-${index}`, 'tool', index === 0 ? {
            sources: [...Array.from({ length: 9 }, (_, sourceIndex) => ({ kind: 'system' as const, executableNames: [`tool-${sourceIndex}`] })),
                { kind: 'manual' as const, instructions }],
            architectures: ['x64', 'a'.repeat(65), ...Array.from({ length: 15 }, (_, architectureIndex) => `arch-${architectureIndex}`)],
        } : { architectures: ['x64'] })).map(entry => ({ ...entry,
            definition: PluginManagedDependencyContributionV2Schema.parse(entry.definition) }));
        const model = createV2ManagedDependencySourceModel({ platform: 'linux', architecture: 'a'.repeat(65), contributions });
        expect(model.snapshot().dependencies).toHaveLength(129);
        const resolved = model.resolve({ pluginId: 'acme.plugin-0', localId: 'tool' });
        expect(resolved.sources).toHaveLength(10);
        expect(resolved.definition.architectures).toHaveLength(17);
        expect(resolved.definition.sources[9]).toMatchObject({ kind: 'manual', instructions });
        expect(resolved.availability).toEqual({ state: 'available' });
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
                architectures: ['x64', 'x64'],
            })],
        })).toThrowError(expect.objectContaining({ code: 'plugin_managed_dependency_source_invalid' }));

    });

    it('does not expose a synthetic occurrenceId-specific retirement method', () => {
        const model = createV2ManagedDependencySourceModel({
            platform: 'linux', architecture: 'arm64',
            contributions: [contribution('acme.one', 'tool')],
        });

        expect(model).not.toHaveProperty('retireGeneration');
    });
});
