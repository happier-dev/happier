import * as React from 'react';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { Icon } from '@/components/ui/icons/Icon';

const bundledBrands = vi.hoisted(() => [] as Readonly<{ pluginId: string; resourceId: string; releaseVersion: string; displayName: string; digest: string; bytes: Uint8Array; monochrome: boolean }>[]);
// The app/Expo byte inventory is a package asset boundary; presentation and admission stay real.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [],
    BUNDLED_PLUGIN_UI_APP_DECLARATIONS: [],
    BUNDLED_PLUGIN_BRAND_MARKS: bundledBrands,
}));

vi.mock('react-native-svg', async (importOriginal) => ({
    ...(await importOriginal<typeof import('react-native-svg')>()),
    SvgXml: (props: Record<string, unknown>) => React.createElement('SvgXml', props),
}));

import { ProviderIcon } from './ProviderIcon';
import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';

bundledBrands.push({
    pluginId: 'happier.provider.deepseek', resourceId: 'brand-icon', releaseVersion: '0.0.0',
    displayName: 'DeepSeek', digest: '', monochrome: true,
    bytes: new Uint8Array(readFileSync(new URL('../../../../../packages/plugins/deepseek/assets/brand.png', import.meta.url))),
});

describe('ProviderIcon', () => {
    it('uses a contributed installed icon token and fails safely to the generic provider icon', async () => {
        const contributed = await renderScreen(<ProviderIcon icon="sparkle" size={29} color="black" />);
        expect(contributed.findByType(Icon).props.name).toBe('sparkle');
        const fallback = await renderScreen(<ProviderIcon icon="https://remote.example/icon.svg" size={29} color="black" />);
        expect(fallback.findByType(Icon).props.name).toBe('cube');
    });

    it('draws the packaged plugin mark selected by contribution identity, independent of its icon token', async () => {
        const mark = await renderScreen(<ProviderIcon contributionKey="happier.provider.deepseek/deepseek" icon="cube" size={24} color="#123456" />);
        expect(mark.findAllByType(Icon)).toHaveLength(0);
        const image = mark.findByType('Image');
        expect(image.props.source.uri).toMatch(/^data:image\/png;base64,/);
        expect(image.props.tintColor).toBe('#123456');
        const tokenOnly = await renderScreen(<ProviderIcon icon="deepseek" size={24} color="#123456" />);
        expect(tokenOnly.findByType(Icon).props.name).toBe('cube');
    });
    it('draws every bundled Provider with its plugin\'s packaged artwork, never a letter or the cube', async () => {
        // The byte inventory comes from each first-party package's published manifest brand (the tracked catalog
        // projection, one file per package directory), as the app publisher reads it.
        const pluginsRoot = new URL('../../../../../packages/plugins/', import.meta.url);
        const manifestsRoot = new URL('../../../../cli/assets/bundled-plugin-manifests/', import.meta.url);
        bundledBrands.length = 0;
        for (const file of readdirSync(manifestsRoot).filter((name) => name.endsWith('.json'))) {
            const directory = file.slice(0, -'.json'.length);
            const manifest = JSON.parse(readFileSync(new URL(file, manifestsRoot), 'utf8'));
            const resource = manifest.brand
                ? manifest.contributes?.resources?.find((entry: { id: string }) => entry.id === manifest.brand.iconResourceId)
                : null;
            if (!resource) continue;
            bundledBrands.push({
                pluginId: manifest.id, resourceId: resource.id, releaseVersion: '0.0.0', displayName: manifest.displayName,
                digest: '', monochrome: manifest.brand.monochrome === true,
                bytes: new Uint8Array(readFileSync(new URL(`${directory}/${resource.path}`, pluginsRoot))),
            });
        }
        const declarations = readAccountProviderDeclarations({ kind: 'account' });
        expect(declarations.map((declaration) => declaration.contributionKey)).toEqual(expect.arrayContaining([
            expect.stringContaining('cloudflare-ai-gateway'), expect.stringContaining('vercel-ai-gateway'),
        ]));
        const unmarked: string[] = [];
        for (const { contributionKey } of declarations) {
            // Anthropic is contributed by the Claude plugin, whose admitted artwork is its Agent brand.
            const rendered = await renderScreen(<ProviderIcon contributionKey={contributionKey} icon={null} size={24} color="#123456" />);
            const artwork = rendered.findAllByType('Image').length + rendered.findAllByType('SvgXml').length;
            if (artwork === 0 || rendered.findAllByType(Icon).length > 0) unmarked.push(contributionKey);
        }
        expect(unmarked).toEqual([]);
    });
});
