import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        View: 'View',
    };
});

vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    SessionGettingStartedGuidance: 'SessionGettingStartedGuidance',
    useSessionGettingStartedGuidanceBaseModel: () => ({
        kind: 'connect_machine',
        targetLabel: 'Test server',
        serverId: 's1',
        serverName: 'Test',
        serverUrl: 'https://api.happier.dev',
        showServerSetup: false,
    }),
}));

vi.mock('@/components/sessions/new/hooks/useNewSessionScreenModel', () => ({
    useNewSessionScreenModel: () => ({
        variant: 'wizard',
        popoverBoundaryRef: { current: null },
        wizardProps: {
            layout: null,
            profiles: null,
            agent: null,
            machine: null,
            footer: null,
        },
    }),
}));

vi.mock('@/components/sessions/new/components/NewSessionSimplePanel', () => ({
    NewSessionSimplePanel: 'NewSessionSimplePanel',
}));

vi.mock('@/components/sessions/new/components/NewSessionWizard', () => ({
    NewSessionWizard: 'NewSessionWizard',
}));

vi.mock('@/components/ui/popover', () => ({
    PopoverBoundaryProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
    PopoverPortalTargetProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('/new (blocking guidance)', () => {
    it('hard-stops with connect-machine guidance when no machines exist', async () => {
        const Screen = (await import('@/app/(app)/new')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(React.createElement(Screen));
        });

        expect(() => tree!.root.findByType('SessionGettingStartedGuidance')).not.toThrow();
        expect(() => tree!.root.findByType('NewSessionWizard')).toThrow();
    });
});

