import { describe, expect, it } from 'vitest';

import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { ScmHostingProviderRuntimeRegistration } from '@happier-dev/plugin-sdk/experimental/scm';
import {
    PLUGIN_MANIFEST as GITHUB_PLUGIN_MANIFEST,
    activate as activateGithub,
} from '@happier-dev/plugins-scm-github';
import {
    PLUGIN_MANIFEST as GITLAB_PLUGIN_MANIFEST,
    activate as activateGitlab,
} from '@happier-dev/plugins-scm-gitlab';

import { createScmHostingProviderRegistry } from './registry';

type PluginScmHostingProviderRuntime = Parameters<
    PluginApi['scm']['registerHostingProvider']
>[1];

function createBundledRegistry(input: Readonly<{
    manifest: typeof GITHUB_PLUGIN_MANIFEST | typeof GITLAB_PLUGIN_MANIFEST;
    activate: typeof activateGithub | typeof activateGitlab;
}>) {
    const registrations: ScmHostingProviderRuntimeRegistration[] = [];
    input.activate({
        connectedAccounts: {
            register() {
                return { dispose() {} };
            },
        },
        scm: {
            registerHostingProvider(id: string, registration: PluginScmHostingProviderRuntime) {
                registrations.push({ id, ...registration });
                return { dispose() {} };
            },
        },
    } as unknown as Parameters<typeof input.activate>[0]);

    return createScmHostingProviderRegistry({
        providers: input.manifest.contributes.scmHostingProviders.map((provider) => ({
            ...provider,
            pluginId: input.manifest.id,
            displayName: provider.title,
        })),
        runtimeRegistrations: registrations.map((registration) => ({
            pluginId: input.manifest.id,
            generation: 'test-generation',
            registration,
        })),
    });
}

describe('bundled SCM hosting-provider identity', () => {
    it.each([
        {
            name: 'GitHub',
            manifest: GITHUB_PLUGIN_MANIFEST,
            activate: activateGithub,
            remoteUrl: 'https://github.com/happier-dev/happier.git',
            expectedUrl: 'https://github.com/happier-dev/happier/compare/main...feature',
        },
        {
            name: 'GitLab',
            manifest: GITLAB_PLUGIN_MANIFEST,
            activate: activateGitlab,
            remoteUrl: 'https://gitlab.com/happier-dev/happier.git',
            expectedUrl: 'https://gitlab.com/happier-dev/happier/-/compare/main...feature',
        },
    ])('keeps the qualified $name identity usable from detection through compare URL creation', ({
        manifest,
        activate,
        remoteUrl,
        expectedUrl,
    }) => {
        const registry = createBundledRegistry({ manifest, activate });
        const detected = registry.detectRemote({ remoteName: 'origin', remoteUrl });

        expect(detected.kind).toBe('resolved');
        if (detected.kind !== 'resolved') return;
        expect(detected.provider.id).toBe(`${manifest.id}/${manifest.contributes.scmHostingProviders[0].id}`);
        expect(registry.buildCompareUrl({
            provider: detected.provider,
            base: 'main',
            head: 'feature',
        })).toEqual({
            kind: 'resolved',
            url: expectedUrl,
        });
    });
});
