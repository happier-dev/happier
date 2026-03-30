import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';

import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ServerScopedMachine } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type CapturedMachineSelectorProps = Readonly<Record<string, unknown>>;
type CapturedServerScopedMachineSelectorProps = Readonly<Record<string, unknown>>;

const capturedMachineSelectorProps: CapturedMachineSelectorProps[] = [];
const capturedServerScopedMachineSelectorProps: CapturedServerScopedMachineSelectorProps[] = [];

installNewSessionComponentsCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children }: { children?: React.ReactNode }) => React.createElement('Text', null, children),
}));

vi.mock('./MachineSelector', () => ({
    MachineSelector: (props: CapturedMachineSelectorProps) => {
        capturedMachineSelectorProps.push(props);
        return null;
    },
}));

vi.mock('./ServerScopedMachineSelector', () => ({
    ServerScopedMachineSelector: (props: CapturedServerScopedMachineSelectorProps) => {
        capturedServerScopedMachineSelectorProps.push(props);
        return null;
    },
}));

describe('NewSessionMachineSelectionContent', () => {
    const baseMachine = {
        id: 'machine-1',
        metadata: { host: 'host-1', displayName: 'Machine 1', homeDir: '/home/me' },
    } as Machine;
    const baseScopedMachine = {
        ...baseMachine,
        serverId: 'server-b',
        serverName: 'Server B',
    } as ServerScopedMachine;

    it('renders the empty state when no groups are available', async () => {
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');

        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(React.createElement(NewSessionMachineSelectionContent, {
                    groups: [],
                    selectedMachine: null,
                    selectedServerId: null,
                    recentMachines: [],
                    favoriteMachines: [],
                    onSelectMachine: vi.fn(),
                    onSelectScopedMachine: vi.fn(),
                }))).tree;

        expect(capturedMachineSelectorProps).toHaveLength(0);
        expect(capturedServerScopedMachineSelectorProps).toHaveLength(0);
        expect(tree?.toJSON()).toMatchObject({
            children: ['newSession.noMachinesFound'],
        });
    });

    it('renders the empty state when every server group is empty and idle', async () => {
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');

        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(React.createElement(NewSessionMachineSelectionContent, {
                    groups: [
                        {
                            serverId: 'server-a',
                            serverName: 'Server A',
                            loading: false,
                            signedOut: false,
                            machines: [],
                        },
                        {
                            serverId: 'server-b',
                            serverName: 'Server B',
                            loading: false,
                            signedOut: false,
                            machines: [],
                        },
                    ],
                    selectedMachine: null,
                    selectedServerId: 'server-a',
                    recentMachines: [],
                    favoriteMachines: [],
                    onSelectMachine: vi.fn(),
                    onSelectScopedMachine: vi.fn(),
                }))).tree;

        expect(capturedMachineSelectorProps).toHaveLength(0);
        expect(capturedServerScopedMachineSelectorProps).toHaveLength(0);
        expect(tree?.toJSON()).toMatchObject({
            children: ['newSession.noMachinesFound'],
        });
    });

    it('renders MachineSelector for a single server group and forwards route controls', async () => {
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const onSelectMachine = vi.fn();
        const onSelectScopedMachine = vi.fn();
        const onToggleFavorite = vi.fn();

        capturedMachineSelectorProps.length = 0;
        capturedServerScopedMachineSelectorProps.length = 0;

        await renderScreen(React.createElement(NewSessionMachineSelectionContent, {
                    groups: [
                        {
                            serverId: 'server-b',
                            serverName: 'Server B',
                            loading: false,
                            signedOut: false,
                            machines: [baseScopedMachine],
                        },
                    ],
                    selectedMachine: baseMachine,
                    selectedServerId: 'server-b',
                    recentMachines: [baseMachine],
                    favoriteMachines: [baseMachine],
                    onSelectMachine,
                    onSelectScopedMachine,
                    onToggleFavorite,
                    serverId: 'server-b',
                    showCliGlyphs: false,
                    autoDetectCliGlyphs: false,
                }));

        expect(capturedServerScopedMachineSelectorProps).toHaveLength(0);
        expect(capturedMachineSelectorProps).toHaveLength(1);
        expect(capturedMachineSelectorProps[0]).toMatchObject({
            machines: [baseMachine],
            selectedMachine: baseMachine,
            recentMachines: [baseMachine],
            favoriteMachines: [baseMachine],
            onSelect: onSelectMachine,
            onToggleFavorite,
            serverId: 'server-b',
            showCliGlyphs: false,
            autoDetectCliGlyphs: false,
        });
        expect(typeof capturedMachineSelectorProps[0]?.onSelect).toBe('function');
        expect(typeof capturedMachineSelectorProps[0]?.onToggleFavorite).toBe('function');
    });

    it('forwards the machine-search visibility flag to the single-server popover selector', async () => {
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');

        capturedMachineSelectorProps.length = 0;
        capturedServerScopedMachineSelectorProps.length = 0;

        await renderScreen(React.createElement(NewSessionMachineSelectionContent, {
                    groups: [
                        {
                            serverId: 'server-b',
                            serverName: 'Server B',
                            loading: false,
                            signedOut: false,
                            machines: [baseScopedMachine],
                        },
                    ],
                    selectedMachine: baseMachine,
                    selectedServerId: 'server-b',
                    recentMachines: [],
                    favoriteMachines: [],
                    onSelectMachine: vi.fn(),
                    onSelectScopedMachine: vi.fn(),
                    showSearch: false,
                }));

        expect(capturedMachineSelectorProps).toHaveLength(1);
        expect(capturedMachineSelectorProps[0]).toMatchObject({
            showSearch: false,
        });
    });

    it('renders ServerScopedMachineSelector when multiple server groups are available', async () => {
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const onSelectMachine = vi.fn();
        const onSelectScopedMachine = vi.fn();

        capturedMachineSelectorProps.length = 0;
        capturedServerScopedMachineSelectorProps.length = 0;

        await renderScreen(React.createElement(NewSessionMachineSelectionContent, {
                    groups: [
                        {
                            serverId: 'server-b',
                            serverName: 'Server B',
                            loading: false,
                            signedOut: false,
                            machines: [baseScopedMachine],
                        },
                        {
                            serverId: 'server-c',
                            serverName: 'Server C',
                            loading: false,
                            signedOut: false,
                            machines: [
                                {
                                    ...baseMachine,
                                    serverId: 'server-c',
                                    serverName: 'Server C',
                                } as ServerScopedMachine,
                            ],
                        },
                    ],
                    selectedMachine: baseMachine,
                    selectedServerId: 'server-c',
                    recentMachines: [],
                    favoriteMachines: [],
                    onSelectMachine,
                    onSelectScopedMachine,
                    testIdPrefix: 'new-session-machine',
                }));

        expect(capturedMachineSelectorProps).toHaveLength(0);
        expect(capturedServerScopedMachineSelectorProps).toHaveLength(1);
        expect(capturedServerScopedMachineSelectorProps[0]).toMatchObject({
            groups: expect.any(Array),
            selectedMachineId: 'machine-1',
            selectedServerId: 'server-c',
            onSelect: onSelectScopedMachine,
            testIdPrefix: 'new-session-machine',
        });
    });
});
