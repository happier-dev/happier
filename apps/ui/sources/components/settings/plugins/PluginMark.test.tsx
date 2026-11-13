import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginMark } from './PluginMark';
import { createValidPluginBrandPngFixture } from '@/dev/testkit';
import { materializeHappierRenderableImage } from '@happier-dev/plugin-ui/advanced';
import { getAgentUiConfig } from '@/agents/registry/registryUi';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

const bundledBrands = vi.hoisted(() => [] as { pluginId: string; resourceId: string; releaseVersion: string; displayName: string; digest: string; bytes: Uint8Array }[]);
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [],
    BUNDLED_PLUGIN_UI_APP_DECLARATIONS: [],
    BUNDLED_PLUGIN_BRAND_MARKS: bundledBrands,
}));
beforeEach(() => {
    bundledBrands.splice(0, bundledBrands.length, {
        pluginId: 'happier.inspector', resourceId: 'brand-icon', releaseVersion: '0.0.0',
        displayName: 'Inspector', digest: `sha256:${'b'.repeat(64)}`, bytes: createValidPluginBrandPngFixture(),
    });
});

function render(element: React.ReactElement): ReactTestRenderer {
    let tree!: ReactTestRenderer;
    act(() => {
        tree = create(element);
    });
    return tree;
}

const images = (tree: ReactTestRenderer) => tree.root.findAll((node) => { const type: unknown = node.type; return type === 'Image'; });
const glyphs = (tree: ReactTestRenderer) => tree.root.findAll((node) => node.props?.name === 'puzzle-piece');
const letters = (tree: ReactTestRenderer, letter: string) => tree.root.findAll((node) => (
    typeof node.type === 'string' && node.children.length === 1 && node.children[0] === letter
));

describe('PluginMark', () => {
    it('renders the packaged non-Agent mark in chrome without a connected machine', () => {
        const tree = render(<PluginMark title="Inspector" pluginId="happier.inspector" />);
        expect(tree.root.findAll((node) => (node.type as unknown) === 'Image')).toHaveLength(1);
        expect(letters(tree, 'I')).toHaveLength(0);
    });
    it('uses the canonical packaged brand renderer rather than a puzzle when a package declares artwork', () => {
        const bytes = createValidPluginBrandPngFixture();
        materializeHappierRenderableImage(bytes);
        const tree = render(<PluginMark title="Acme" brand={{ displayName: 'Acme', bytes }} />);
        expect(tree.root.findAll((node) => (node.type as unknown) === 'Image')).toHaveLength(1);
        expect(glyphs(tree)).toHaveLength(0);
    });
    it('shows the contributed Agent logo when that Agent has one', () => {
        const tree = render(<PluginMark title="Some Plugin" iconAgentId="claude" />);
        expect(images(tree)).toHaveLength(1);
        expect(images(tree)[0].props.source).toEqual(getAgentUiConfig('claude').brandArtwork?.light);
        expect(letters(tree, 'S')).toHaveLength(0);
        expect(glyphs(tree)).toHaveLength(0);
    });

    it('keeps bundled Agent identity without a connected machine projection, without guessing unknown package identities', () => {
        const bundled = render(<PluginMark title="Claude" pluginId="happier.agent.claude" iconAgentId={null} />);
        expect(images(bundled)).toHaveLength(1);
        expect(images(bundled)[0].props.source).toEqual(getAgentUiConfig('claude').brandArtwork?.light);
        const external = render(<PluginMark title="Claude fork" pluginId="acme.agent.claude" />);
        expect(images(external)).toHaveLength(0);
        expect(letters(external, 'C').length).toBeGreaterThan(0);
    });

    it('uses the canonical neutral brand identity when there is no Agent artwork', () => {
        // Unknown installed Agents and packages without an Agent retain the neutral identity.
        for (const iconAgentId of ['acme/reviewer', null]) {
            const tree = render(<PluginMark title="Some Plugin" iconAgentId={iconAgentId} />);
            expect(images(tree)).toHaveLength(0);
            expect(glyphs(tree)).toHaveLength(0);
            expect(letters(tree, 'S').length).toBeGreaterThan(0);
        }
    });

    it.each(['coderabbit', 'deepsec'])('shows the descriptor-owned %s review mark through the real Agent catalog', (iconAgentId) => {
        const tree = render(<PluginMark title="Reviewer" iconAgentId={iconAgentId} />);
        expect(images(tree)).toHaveLength(1);
        const artwork = getAgentUiConfig(iconAgentId).brandArtwork;
        expect(artwork?.light).toBeDefined();
        expect(images(tree)[0].props.source).toEqual(artwork?.light);
        expect(letters(tree, 'R')).toHaveLength(0);
    });

    it('draws the same rule at the head of the plugin page', () => {
        const tree = render(<PluginMark title="Claude" iconAgentId="claude" size="page" />);
        expect(images(tree)).toHaveLength(1);
        expect(images(tree)[0].props.source).toEqual(getAgentUiConfig('claude').brandArtwork?.light);
        expect(letters(render(<PluginMark title="Notes" size="page" />), 'N').length).toBeGreaterThan(0);
    });
});
