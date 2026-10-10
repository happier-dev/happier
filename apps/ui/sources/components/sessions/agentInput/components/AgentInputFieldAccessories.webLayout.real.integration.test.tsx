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

describe('the dictionary and mic in a document composer\'s chip row, as a browser lays them out', () => {
    it('sit on the chips\' line, not above it (DESIGN-7 P1, lab editor-E1)', async () => {
        const { AgentInputFieldAccessories } = await import('./AgentInputFieldAccessories');
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => {
            root!.render(React.createElement(View, { style: { width: 600, flexDirection: 'row', alignItems: 'center' } },
                React.createElement(View, { testID: 'chip', style: { width: 160, height: 28 } }),
                React.createElement(AgentInputFieldAccessories, {
                    showLibrary: true, onOpenLibrary: () => {}, belowToggle: false, placement: 'actionRow',
                    accessory: React.createElement(View, { testID: 'mic', style: { width: 24, height: 24 } }),
                })));
        });
        const layout = await measureWebLayout(host, { viewport: { width: 600, height: 200 }, settle: (replay) => act(replay) });
        const chip = layout.rect('chip');
        expect(Math.abs(centre(layout.rect('agent-input-prompt-library-surface')) - centre(chip))).toBeLessThanOrEqual(2);
        expect(Math.abs(centre(layout.rect('mic')) - centre(chip))).toBeLessThanOrEqual(2);
    });
});
