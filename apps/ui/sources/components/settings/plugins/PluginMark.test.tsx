import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { PluginMark } from './PluginMark';
import { createValidPluginBrandPngFixture } from '@/dev/testkit';
import { materializeHappierRenderableImage } from '@happier-dev/plugin-ui/advanced';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

// SVG is a native/platform rendering boundary; keep catalog and AgentIcon resolution real.
vi.mock('react-native-svg', () => ({
    SvgXml: (props: Record<string, unknown>) => React.createElement('SvgXml', props),
}));

function render(element: React.ReactElement): ReactTestRenderer {
    let tree!: ReactTestRenderer;
    act(() => {
        tree = create(element);
    });
    return tree;
}

const agentLogos = (tree: ReactTestRenderer) => tree.root.findAll((node) => (node.type as unknown) === 'SvgXml');
const glyphs = (tree: ReactTestRenderer) => tree.root.findAll((node) => node.props?.name === 'puzzle-piece');
const letters = (tree: ReactTestRenderer, letter: string) => tree.root.findAll((node) => (
    typeof node.type === 'string' && node.children.length === 1 && node.children[0] === letter
));

describe('PluginMark', () => {
    it('uses the canonical packaged brand renderer rather than a puzzle when a package declares artwork', () => {
        const bytes = createValidPluginBrandPngFixture();
        materializeHappierRenderableImage(bytes);
        const tree = render(<PluginMark title="Acme" brand={{ displayName: 'Acme', bytes }} />);
        expect(tree.root.findAll((node) => (node.type as unknown) === 'Image')).toHaveLength(1);
        expect(glyphs(tree)).toHaveLength(0);
    });
    it('shows the contributed Agent logo when that Agent has one', () => {
        const tree = render(<PluginMark title="Some Plugin" iconAgentId="claude" />);
        expect(agentLogos(tree)).toHaveLength(1);
        expect(glyphs(tree)).toHaveLength(0);
    });

    it('keeps bundled Agent identity without a connected machine projection, without guessing unknown package identities', () => {
        const bundled = render(<PluginMark title="Claude" pluginId="happier.agent.claude" iconAgentId={null} />);
        expect(agentLogos(bundled)).toHaveLength(1);
        expect(agentLogos(bundled)[0].props.width).toBe(28);
        const external = render(<PluginMark title="Claude fork" pluginId="acme.agent.claude" />);
        expect(agentLogos(external)).toHaveLength(0);
        expect(letters(external, 'C').length).toBeGreaterThan(0);
    });

    it('uses the canonical neutral brand identity when there is no Agent artwork', () => {
        // Unknown installed Agents and packages without an Agent retain the neutral identity.
        for (const iconAgentId of ['acme/reviewer', null]) {
            const tree = render(<PluginMark title="Some Plugin" iconAgentId={iconAgentId} />);
            expect(agentLogos(tree)).toHaveLength(0);
            expect(glyphs(tree)).toHaveLength(0);
            expect(letters(tree, 'S').length).toBeGreaterThan(0);
        }
    });

    it.each(['coderabbit', 'deepsec'])('shows the descriptor-owned %s review mark through the real Agent catalog', (iconAgentId) => {
        const tree = render(<PluginMark title="Reviewer" iconAgentId={iconAgentId} />);
        expect(agentLogos(tree)).toHaveLength(1);
        expect(agentLogos(tree)[0].props.xml).toContain('<path');
        expect(agentLogos(tree)[0].props.width).toBe(28);
    });

    it('draws the same rule at the head of the plugin page', () => {
        expect(agentLogos(render(<PluginMark title="Claude" iconAgentId="claude" size="page" />))).toHaveLength(1);
        expect(letters(render(<PluginMark title="Notes" size="page" />), 'N').length).toBeGreaterThan(0);
    });
});
