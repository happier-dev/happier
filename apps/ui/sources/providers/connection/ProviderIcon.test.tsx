import * as React from 'react';
import { readFileSync } from 'node:fs';
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
    it('draws one identity for every bundled Provider: its plugin\'s admitted artwork, else the shared letter, never the cube', async () => {
        // Anthropic is contributed by the Claude plugin, whose admitted artwork is its brand.
        const anthropic = await renderScreen(<ProviderIcon contributionKey="happier.agent.claude/anthropic" icon={null} size={24} color="#123456" />);
        expect(anthropic.findAllByType(Icon)).toHaveLength(0);
        expect(anthropic.findAllByType('Image').length + anthropic.findAllByType('SvgXml').length).toBeGreaterThan(0);
        // No artwork is admitted for Cloudflare AI Gateway: the same bare grapheme every other unmarked item draws.
        const gateway = await renderScreen(<ProviderIcon contributionKey="happier.provider.cloudflare-ai-gateway/cloudflare-ai-gateway" icon={null} size={24} color="#123456" />);
        expect(gateway.findAllByType(Icon)).toHaveLength(0);
        expect(gateway.getTextContent()).toContain('C');
    });
});
