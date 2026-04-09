import * as React from 'react';
import { describe, expect, it } from 'vitest';

describe('normalizeNodeForView', () => {
    it('drops invalid React element types instead of passing them through to View renderers', async () => {
        const { normalizeNodeForView } = await import('./normalizeNodeForView');

        const node = {
            $$typeof: Symbol.for('react.transitional.element'),
            type: undefined,
            key: null,
            props: { name: 'flash-outline', size: 16 },
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
});
