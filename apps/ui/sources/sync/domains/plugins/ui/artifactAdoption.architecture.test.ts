import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Plugin UI Artifact adoption ownership', () => {
    it('keeps renderer acquisition and consumer retirement in the consumed UI owner', async () => {
        const [hostSource, paneSource] = await Promise.all([
            readFile(new URL('../../../../components/plugins/surfaces/PluginSurfaceHost.tsx', import.meta.url), 'utf8'),
            readFile(new URL('../../../../components/plugins/hostedWeb/PluginHostedWebPane.tsx', import.meta.url), 'utf8'),
        ]);

        expect(hostSource).not.toMatch(/\bacquirePluginHostedWebArtifactAvailability\b/u);
        expect(hostSource).not.toMatch(/\bacquirePluginHostedWebArtifactBrowserAvailability\b/u);
        expect(hostSource).not.toMatch(/\bacquirePluginReactNativeArtifactAvailability\b/u);
        expect(hostSource).not.toMatch(/\bgetInstalledPluginReactNativeBundleCache\b/u);
        expect(hostSource).not.toMatch(/\bloadPluginReactNativeBundleModule\b/u);
        expect(hostSource).not.toContain('hostedWebBrowser');
        expect(hostSource).toContain("@/sync/domains/plugins/ui/artifactAdoption");

        expect(paneSource).toContain("@/sync/domains/plugins/ui/artifactAdoption");
        expect(paneSource).toContain('nativeArtifactAdoption');
        expect(paneSource).not.toContain('nativeArtifactHandle?:');
        expect(paneSource).not.toContain('webArtifactAdoption');
        expect(paneSource).not.toContain('hostedWebBrowser');

        const ownerSource = await readFile(new URL('./artifactAdoption.ts', import.meta.url), 'utf8');
        expect(ownerSource).toContain('PluginUiArtifactAdoptionOwner');
        expect(ownerSource).toContain('acquirePluginHostedWebArtifactAvailability');
        expect(ownerSource).toContain('acquirePluginReactNativeArtifactAvailability');
        expect(ownerSource).not.toContain('hostedWebBrowser');
        await expect(readFile(
            new URL('../availability/hostedWebArtifactBrowserAvailability.web.ts', import.meta.url),
            'utf8',
        )).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
