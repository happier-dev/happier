// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

installWebLayoutBridge();

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
});

const centre = (rect: Readonly<{ top: number; height: number }>) => rect.top + rect.height / 2;

describe('the library and mic in a composer\'s field corner, as a browser lays them out', () => {
    it('share one centre line (owner 09.13.20: off-centre with each other)', async () => {
        const { AgentInputFieldAccessories } = await import('./AgentInputFieldAccessories');
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => {
            root!.render(React.createElement(View, { style: { width: 600, height: 80, position: 'relative' } },
                React.createElement(AgentInputFieldAccessories, {
                    showLibrary: true, onOpenLibrary: () => {}, belowToggle: false,
                    accessory: React.createElement(View, { testID: 'mic', style: { width: 24, height: 24 } }),
                })));
        });
        const layout = await measureWebLayout(host, { viewport: { width: 600, height: 200 }, settle: (replay) => act(replay) });
        expect(Math.abs(centre(layout.rect('agent-input-prompt-library-surface')) - centre(layout.rect('mic')))).toBeLessThanOrEqual(1);
    });
});
