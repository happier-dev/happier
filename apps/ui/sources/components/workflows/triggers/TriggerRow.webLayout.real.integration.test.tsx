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
const { TextLinkButton } = await import('@/components/ui/buttons/TextLinkButton');

it('ends the habit row before its actions line begins, so the row and the line never share a tap', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const theme = document.createElement('style');
    theme.textContent = readFileSync(resolve(process.cwd(), 'sources/theme.css'), 'utf8');
    document.head.append(theme);
    document.documentElement.style.setProperty('--colors-border-focus', createThemeFixture().colors.border.focus);
    try {
        await act(async () => root.render(
            <TriggerRow testID="habit" title="Memory upkeep" qualifier="Every day" enabled onToggle={() => {}} onPress={() => {}}
                actions={<><TextLinkButton testID="habit-history" label="History" onPress={() => {}} />
                    <TextLinkButton testID="habit-run" label="Run now" onPress={() => {}} /></>} />,
        ));
        for (const width of [390, 900]) {
            const layout = await measureWebLayout(host, { viewport: { width, height: 700 } });
            const row = layout.rect('habit');
            const actions = layout.rect('habit-actions');
            // The row's press region ends where the actions line starts: nothing the line draws is under the row.
            expect(row.bottom).toBeLessThanOrEqual(actions.top);
            // And each control of the line is the topmost target at its own centre.
            for (const id of ['habit-history', 'habit-run', 'habit-switch']) {
                expect(layout.rect(id).receivesPointer).toBe(true);
            }
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
        theme.remove();
    }
});
