import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children }: { children?: React.ReactNode }) => React.createElement('mock-text', null, children),
}));

describe('normalizeNodeForView', () => {
    it('drops invalid React element types instead of passing them through to View renderers', async () => {
        const { normalizeNodeForView } = await import('./normalizeNodeForView');

        const node = {
            $$typeof: Symbol.for('react.transitional.element'),
            type: undefined,
            key: null,
            props: { name: 'lightning', size: 16 },
            _owner: null,
        } as unknown as React.ReactElement;

        const normalized = normalizeNodeForView(node);

        expect(normalized).toBeNull();
    });

    it('does not wrap non-text icon components (AgentIcon) in Text', async () => {
        const { normalizeNodeForView } = await import('./normalizeNodeForView');

        function AgentIcon(_props: any) {
            return null;
        }
        AgentIcon.displayName = 'AgentIcon';

        const node = React.createElement(AgentIcon, { size: 14 });
        const normalized = normalizeNodeForView(node);

        // If we wrapped this element, we'd get a different React element.
        expect(normalized).toBe(node);
    });

    it('wraps text-like icon components (name + size props) in Text', async () => {
        const { normalizeNodeForView } = await import('./normalizeNodeForView');

        function Ionicons(_props: any) {
            return null;
        }
        Ionicons.displayName = 'Ionicons';

        const node = React.createElement(Ionicons, { name: 'flash-outline', size: 16 });
        const normalized = normalizeNodeForView(node);

        expect(normalized).not.toBe(node);
        expect(React.isValidElement(normalized)).toBe(true);
        const wrapper = normalized as React.ReactElement<{ children?: React.ReactNode }>;
        expect(wrapper.props.children).toBe(node);
    });

    it('keeps memoized non-text components renderable', async () => {
        const { normalizeNodeForView } = await import('./normalizeNodeForView');

        const MemoAgentIcon = React.memo(function MemoAgentIcon(_props: { size: number }) {
            return null;
        });

        const node = React.createElement(MemoAgentIcon, { size: 14 });
        const normalized = normalizeNodeForView(node);

        expect(normalized).toBe(node);
    });

    it('preserves a single child as a single node (React.Children.only contract)', async () => {
        const { normalizeNodeForView } = await import('./normalizeNodeForView');
        function Box(_props: any) { return null; }
        Box.displayName = 'Box';

        // Mirrors RNGH's GestureDetector web wrapper, which calls
        // React.Children.only(children); collapsing a single child to a
        // one-element ARRAY would make it throw.
        const inner = React.createElement(Box);
        const node = React.createElement(Box, null, inner);
        const normalized = normalizeNodeForView(node) as React.ReactElement;
        const children = (normalized.props as { children?: React.ReactNode }).children;

        expect(Array.isArray(children)).toBe(false);
        expect(() => React.Children.only(children)).not.toThrow();
    });

    it('fans out multiple children to an array, preserves Fragment children, and tolerates empty children', async () => {
        const { normalizeNodeForView } = await import('./normalizeNodeForView');
        function Box(_props: any) { return null; }
        Box.displayName = 'Box';

        const multi = React.createElement(Box, null, React.createElement(Box, { key: 'a' }), React.createElement(Box, { key: 'b' }));
        const normalizedMulti = normalizeNodeForView(multi) as React.ReactElement;
        const multiChildren = (normalizedMulti.props as { children?: React.ReactNode }).children;
        expect(Array.isArray(multiChildren)).toBe(true);
        expect(React.Children.count(multiChildren)).toBe(2);

        const nullChildren = React.createElement(Box, { children: null });
        expect(() => normalizeNodeForView(nullChildren)).not.toThrow();

        const frag = React.createElement(React.Fragment, null, React.createElement(Box, { key: 'a' }), React.createElement(Box, { key: 'b' }));
        const normalizedFrag = normalizeNodeForView(frag) as React.ReactElement;
        expect(React.Children.count((normalizedFrag.props as { children?: React.ReactNode }).children)).toBe(2);
    });
});
