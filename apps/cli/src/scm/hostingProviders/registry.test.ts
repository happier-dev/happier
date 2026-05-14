import { describe, expect, it } from 'vitest';

import type { ScmHostingProviderRuntimeRegistration } from '@happier-dev/plugin-sdk';
import type { ScmHostingProviderContributionKind } from '@happier-dev/protocol';

import { createScmHostingProviderRegistry } from './registry';

type DetectedProviderFixture = Omit<NonNullable<
    ReturnType<NonNullable<ScmHostingProviderRuntimeRegistration['adapter']['detectRemote']>>
>, 'id' | 'kind'> & Readonly<{
    id: ScmHostingProviderContributionKind;
    kind: ScmHostingProviderContributionKind;
}>;

function createRegistryWithDetectedProvider(
    detectedProvider: DetectedProviderFixture,
) {
    const registration: ScmHostingProviderRuntimeRegistration = {
        id: detectedProvider.id,
        adapter: {
            detectRemote: () => detectedProvider,
            buildCompareUrl: () => null,
        },
    };

    return createScmHostingProviderRegistry({
        providers: [{
            id: detectedProvider.id,
            kind: detectedProvider.kind,
            displayName: detectedProvider.displayName,
            baseUrl: detectedProvider.baseUrl,
        }],
        runtimeRegistrations: [{
            pluginId: `happier.scm.${detectedProvider.id}`,
            registration,
        }],
    });
}

describe('SCM hosting provider registry', () => {
    it('preserves provider-owned repository web URLs on detected remotes', () => {
        const registry = createRegistryWithDetectedProvider({
            id: 'github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.example.com',
            repositoryWebUrl: 'https://github.example.com/happier-dev/happier',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@github.example.com:happier-dev/happier.git',
        });

        expect(detected.kind).toBe('resolved');
        if (detected.kind !== 'resolved') return;
        expect(detected.provider.repositoryWebUrl).toBe('https://github.example.com/happier-dev/happier');
    });

    it('preserves repository web URLs below a path-scoped provider base', () => {
        const registry = createRegistryWithDetectedProvider({
            id: 'gitlab',
            kind: 'gitlab',
            displayName: 'GitLab',
            baseUrl: 'https://git.example.com/gitlab',
            repositoryWebUrl: 'https://git.example.com/gitlab/happier-dev/happier',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@git.example.com:happier-dev/happier.git',
        });

        expect(detected.kind).toBe('resolved');
        if (detected.kind !== 'resolved') return;
        expect(detected.provider.repositoryWebUrl).toBe('https://git.example.com/gitlab/happier-dev/happier');
    });

    it('drops repository web URLs outside the provider base path', () => {
        const registry = createRegistryWithDetectedProvider({
            id: 'gitlab',
            kind: 'gitlab',
            displayName: 'GitLab',
            baseUrl: 'https://git.example.com/gitlab',
            repositoryWebUrl: 'https://git.example.com/other/happier-dev/happier',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@git.example.com:happier-dev/happier.git',
        });

        expect(detected.kind).toBe('resolved');
        if (detected.kind !== 'resolved') return;
        expect(detected.provider.repositoryWebUrl).toBeUndefined();
    });

    it('drops repository web URLs with unsupported schemes', () => {
        const registry = createRegistryWithDetectedProvider({
            id: 'github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.example.com',
            repositoryWebUrl: 'http://github.example.com/happier-dev/happier',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@github.example.com:happier-dev/happier.git',
        });

        expect(detected.kind).toBe('resolved');
        if (detected.kind !== 'resolved') return;
        expect(detected.provider.repositoryWebUrl).toBeUndefined();
    });

    it('drops repository web URLs when runtime safety widens descriptor schemes', () => {
        const registry = createRegistryWithDetectedProvider({
            id: 'github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'http://github.example.com',
            repositoryWebUrl: 'http://github.example.com/happier-dev/happier',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
            urlSafety: {
                allowedSchemes: ['http:'],
            },
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@github.example.com:happier-dev/happier.git',
        });

        expect(detected.kind).toBe('resolved');
        if (detected.kind !== 'resolved') return;
        expect(detected.provider.repositoryWebUrl).toBeUndefined();
    });

    it('drops malformed repository web URLs', () => {
        const registry = createRegistryWithDetectedProvider({
            id: 'github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.example.com',
            repositoryWebUrl: 'not a url',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@github.example.com:happier-dev/happier.git',
        });

        expect(detected.kind).toBe('resolved');
        if (detected.kind !== 'resolved') return;
        expect(detected.provider.repositoryWebUrl).toBeUndefined();
    });

    it('drops repository web URLs with credentials', () => {
        const registry = createRegistryWithDetectedProvider({
            id: 'github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.example.com',
            repositoryWebUrl: 'https://token@github.example.com/happier-dev/happier',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@github.example.com:happier-dev/happier.git',
        });

        expect(detected.kind).toBe('resolved');
        if (detected.kind !== 'resolved') return;
        expect(detected.provider.repositoryWebUrl).toBeUndefined();
    });

    it('drops repository web URLs with query strings', () => {
        const registry = createRegistryWithDetectedProvider({
            id: 'github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.example.com',
            repositoryWebUrl: 'https://github.example.com/happier-dev/happier?tab=readme',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@github.example.com:happier-dev/happier.git',
        });

        expect(detected.kind).toBe('resolved');
        if (detected.kind !== 'resolved') return;
        expect(detected.provider.repositoryWebUrl).toBeUndefined();
    });

    it('drops repository web URLs with fragments', () => {
        const registry = createRegistryWithDetectedProvider({
            id: 'github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.example.com',
            repositoryWebUrl: 'https://github.example.com/happier-dev/happier#readme',
            nameWithOwner: 'happier-dev/happier',
            remoteName: 'origin',
        });

        const detected = registry.detectRemote({
            remoteName: 'origin',
            remoteUrl: 'git@github.example.com:happier-dev/happier.git',
        });

        expect(detected.kind).toBe('resolved');
        if (detected.kind !== 'resolved') return;
        expect(detected.provider.repositoryWebUrl).toBeUndefined();
    });
});
