import { describe, expect, it } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { SecurityOriginIndicator } from './SecurityOriginIndicator';

describe('SecurityOriginIndicator accessibility', () => {
    it.each([false, true])('names the origin group in compact=%s', async compact => {
        try {
            const screen = await renderScreen(<SecurityOriginIndicator view={null} compact={compact} testID="security" />);
            const indicator = screen.findByTestId('security');
            expect(indicator?.props.role).toBe('group');
            expect(indicator?.props.accessibilityLabel).toBeTruthy();
        } finally { standardCleanup(); }
    });
});
