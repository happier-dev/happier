// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';

import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

installWebLayoutBridge();

const { TriggerRow } = await import('./TriggerRow');

it('keeps the ⋯ and the switch in the row\'s trailing column, each the topmost target at its centre (owner 0936 #14)', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const theme = document.createElement('style');
    theme.textContent = readFileSync(resolve(process.cwd(), 'sources/theme.css'), 'utf8');
    document.head.append(theme);
    document.documentElement.style.setProperty('--colors-border-focus', createThemeFixture().colors.border.focus);
    try {
        await act(async () => root.render(
            <TriggerRow testID="habit" title="Memory upkeep" when="Every Sunday at 9:00 AM" qualifier="Next run: in 4 days"
                glyph="clock" enabled onToggle={() => {}} onPress={() => {}}
                menuActions={[{ id: 'habit-history', title: 'History', icon: 'clock-counter-clockwise', onPress: () => {} },
                    { id: 'habit-run', title: 'Run now', icon: 'play', onPress: () => {} }]} />,
        ));
        for (const width of [390, 900]) {
            const layout = await measureWebLayout(host, { viewport: { width, height: 700 } });
            const row = layout.rect('habit');
            // No actions line: the row's secondary actions wait behind ⋯ on the row itself.
            expect(host.querySelector('[data-testid="habit-actions"]')).toBeNull();
            for (const id of ['habit-more', 'habit-switch']) {
                const control = layout.rect(id);
                expect(control.top).toBeGreaterThanOrEqual(row.top);
                expect(control.bottom).toBeLessThanOrEqual(row.bottom);
                expect(control.receivesPointer).toBe(true);
            }
            // The ⋯ stands just before the switch, which closes the row.
            expect(layout.rect('habit-more').right).toBeLessThanOrEqual(layout.rect('habit-switch').left);
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
        theme.remove();
    }
});
