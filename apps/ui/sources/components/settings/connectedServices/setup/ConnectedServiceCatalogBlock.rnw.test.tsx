/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

// Exercise the actual web host elements, not the native renderer's Pressable stub.
vi.mock('react-native', () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-reanimated', async () => {
    const mock = (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock();
    const { View } = await import('react-native');
    return { ...mock, default: { ...mock.default, View }, View };
});

import { ConnectedServiceCatalogBlock } from './ConnectedServiceCatalogBlock';
import type { ConnectedServiceSetupCatalogEntry } from './ConnectedServiceSetupPanel';

const entry: ConnectedServiceSetupCatalogEntry = {
    serviceKey: 'happier.agent.gemini/gemini-account',
    service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' },
    entry: null,
    legacyServiceId: 'gemini',
    label: 'Gemini',
    usedBy: [],
    usedByAgentIds: [],
    connectedCount: 0,
    section: 'agents',
    canAdd: true,
};

describe('ConnectedServiceCatalogBlock web activation', () => {
    it('does not activate a non-addable known service from its tile or Connect control', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const connected = vi.fn();
        try {
            await act(async () => { root.render(<ConnectedServiceCatalogBlock
                entry={{ ...entry, canAdd: false }} layout="card" showCount={false} onConnect={connected}
            />); });
            const tile = container.querySelector<HTMLElement>(`[data-testid="connected-service-setup:tile:${entry.serviceKey}"]`);
            const connect = container.querySelector<HTMLElement>(`[data-testid="connected-service-setup:connect:${entry.serviceKey}"]`);
            expect(tile).not.toBeNull();
            expect(connect).not.toBeNull();
            await act(async () => { tile!.click(); connect!.click(); });
            expect(connected).not.toHaveBeenCalled();
        } finally {
            await act(async () => { root.unmount(); });
            container.remove();
        }
    });

    it.each(['card', 'row'] as const)('keeps %s tile and Connect activation valid without nested controls', async (layout) => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const connected = vi.fn();
        try {
            await act(async () => { root.render(<ConnectedServiceCatalogBlock entry={entry} layout={layout} showCount={false} onConnect={connected} />); });
            expect(container.querySelector('button button, button [role="button"], [role="button"] button')).toBeNull();
            const tile = container.querySelector<HTMLElement>('[data-testid="connected-service-setup:tile:happier.agent.gemini/gemini-account"]');
            const connect = container.querySelector<HTMLElement>('[data-testid="connected-service-setup:connect:happier.agent.gemini/gemini-account"]');
            expect(tile).not.toBeNull();
            expect(connect).not.toBeNull();
            await act(async () => { tile!.click(); });
            expect(connected).toHaveBeenCalledTimes(1);
            await act(async () => { connect!.click(); });
            expect(connected).toHaveBeenCalledTimes(2);
            const actions = container.querySelectorAll('button, [role="button"]');
            expect(actions).toHaveLength(1);
        } finally {
            await act(async () => { root.unmount(); });
            container.remove();
        }
    });
});
