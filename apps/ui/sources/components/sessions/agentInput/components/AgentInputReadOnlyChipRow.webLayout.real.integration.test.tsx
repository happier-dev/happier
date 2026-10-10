// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { expect, it, vi } from 'vitest';

import { measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

/** A chip as the composer draws one: a mark and a one-line label that ellipsizes when squeezed. */
function Chip(props: Readonly<{ testID: string; label: string }>) {
    return (
        <View testID={props.testID} style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1, minWidth: 0, height: 32, paddingHorizontal: 10, gap: 6 }}>
            <View style={{ width: 16, height: 16 }} />
            <Text testID={`${props.testID}-label`} numberOfLines={1} style={{ fontSize: 15, flexShrink: 1 }}>{props.label}</Text>
        </View>
    );
}

it.each([300, 900])('never squeezes the engine chip beside a long Step options chip in a %spx card (DESIGN-9 N34)', async (width) => {
    const { AgentInputReadOnlyChipRow } = await import('./AgentInputReadOnlyChipRow');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(
            <View style={{ width }}>
                <AgentInputReadOnlyChipRow testID="row"
                    engine={[<Chip key="engine" testID="engine" label="Choose an agent" />]}
                    chips={[<Chip key="options" testID="options" label="The session that started it" />]} />
            </View>,
        ));
        const layout = await measureWebLayout(host, { viewport: { width: Math.max(width, 390), height: 400 } });
        // Both labels read whole: a narrow card moves Step options under the engine instead.
        expect(layout.rect('engine-label').clipped).toBe(false);
        expect(layout.rect('options-label').clipped).toBe(false);
        const engine = layout.rect('engine');
        const options = layout.rect('options');
        if (width < 400) expect(options.top).toBeGreaterThanOrEqual(engine.bottom);
        else {
            // A wide card keeps one line: the engine first, Step options at its end.
            expect(Math.abs(options.top - engine.top)).toBeLessThanOrEqual(1);
            expect(options.right).toBeGreaterThan(width - 2);
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
