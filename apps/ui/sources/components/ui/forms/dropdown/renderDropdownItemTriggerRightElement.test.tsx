import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

const mockComponents = vi.hoisted(() => {
    const MockIonicons = function MockIonicons(props: Record<string, unknown>) {
        return React.createElement('MockIoniconsHost', props);
    };

    const MockText = function MockText(props: Record<string, unknown> & { children?: React.ReactNode }) {
        return React.createElement('MockTextHost', props, props.children);
    };

    return {
        MockIonicons,
        MockText,
    };
});

vi.mock('@/components/ui/icons/SafeIonicons', () => ({
    SafeIonicons: mockComponents.MockIonicons,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: mockComponents.MockText,
}));

describe('renderDropdownItemTriggerRightElement', () => {
    it('renders the closed-trigger chevron directly instead of wrapping it in Text', async () => {
        const { renderDropdownItemTriggerRightElement } = await import('./renderDropdownItemTriggerRightElement');

        const node = renderDropdownItemTriggerRightElement({
            detail: null,
            open: false,
            detailColor: '#666',
            chevronColor: '#999',
        });

        expect(React.isValidElement(node)).toBe(true);
        // The chevron is drawn by the icon seam now; the contract worth asserting is that it is
        // returned as a bare element rather than wrapped in a Text node.
        expect((node as React.ReactElement).type).toBe('Icon');
    });
});
