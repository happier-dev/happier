import { Platform } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { navigateToSessionRoute } from './navigateToSessionRoute';

const originalPlatform = Platform.OS;
afterEach(() => { Platform.OS = originalPlatform; });

describe('session route history', () => {
    it('pushes each web session visit, including a revisit, for browser Back/Forward', () => {
        Platform.OS = 'web';
        const { state, spies } = createExpoRouterMock();
        for (const sessionId of ['history-a', 'history-b', 'history-a']) {
            navigateToSessionRoute({ router: state.router, sessionId });
        }
        expect(spies.push.mock.calls).toEqual([
            ['/session/history-a'],
            ['/session/history-b'],
            ['/session/history-a'],
        ]);
        expect(spies.navigate).not.toHaveBeenCalled();
    });

    it.each(['ios', 'android'] as const)('keeps the singular session stack on %s', (platform) => {
        Platform.OS = platform;
        const navigate = vi.fn();
        const push = vi.fn();
        navigateToSessionRoute({ router: { navigate, push }, sessionId: 'history-a' });
        expect(navigate).toHaveBeenCalledWith('/session/history-a', expect.any(Object));
        expect(navigate.mock.calls[0]?.[1]?.dangerouslySingular()).toBe('session');
        expect(push).not.toHaveBeenCalled();
    });
});
