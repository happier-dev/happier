import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { AddTargetsSection } from './AddTargetsSection';

describe('server reset action', () => {
    it.each([false, true])('uses reset target availability (%s) for the rendered button', async (canResetServer) => {
        const props = {
            autoMode: false,
            inputUrl: '',
            inputName: '',
            error: null,
            isValidating: false,
            canResetServer,
            onChangeUrl: vi.fn(),
            onChangeName: vi.fn(),
            onResetServer: vi.fn(),
            onAddServer: vi.fn(),
            defaultExpanded: 'server' as const,
            servers: [],
            activeServerId: '',
            onCreateServerGroup: vi.fn(async () => false),
        };
        const screen = await renderScreen(<AddTargetsSection {...props} />);

        expect(screen.findHostByTestId('server-settings-add-reset')?.props.disabled).toBe(!canResetServer);
    });
});
