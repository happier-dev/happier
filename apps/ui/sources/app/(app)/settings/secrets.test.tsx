import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

afterEach(() => {
    standardCleanup();
});

describe('/settings/secrets', () => {
    it('opens Saved Secrets in Credentials, the one place they are listed', async () => {
        const Route = (await import('./secrets')).default;
        const screen = await renderScreen(React.createElement(Route));
        expect(screen.findAll((node) => (node.type as unknown) === 'Redirect')[0]?.props.href)
            .toBe('/(app)/settings/connected-services/secrets');
    });
});
