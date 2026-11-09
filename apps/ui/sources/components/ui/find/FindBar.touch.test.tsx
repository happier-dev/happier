import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { layoutHitArea } from '@/dev/testkit/harness/hitFrameReach';

// A finger is the primary pointer (the platform fact the touch floor reads); everything above it is real.
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});

const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
const { FindBar } = await import('./FindBar');

describe('Find bar note link on touch', () => {
    it.each(['inline', 'keyboardSeated'] as const)(
        'keeps the %s note link inside the note\'s own padding, so it never reaches the field beside the note',
        async (presentation) => {
            const screen = await renderScreen(
                <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                    <KeyboardShortcutProvider handlers={{}}>
                        <FindBar testID="note-find" query="needle" onQueryChange={() => {}}
                            options={{ matchCase: false, regex: false }} onOptionsChange={() => {}}
                            status={{ kind: 'idle' }} capabilities={{ regex: true, stop: false }}
                            onStep={() => {}} onStop={() => {}} onClose={() => {}} surfaceLabel="Find in file"
                            presentation={presentation}
                            note={{ icon: 'info', text: 'Older pages did not load', action: { label: 'Retry', onPress: () => {}, testID: 'note-find-retry' } }} />
                    </KeyboardShortcutProvider>
                </HappierUiPlatformProvider>,
            );
            const area = await layoutHitArea(() => screen.findByTestId('note-find-retry'), { width: 36, height: 16 });
            const padding = presentation === 'keyboardSeated' ? 6 : 7;
            expect(area.insets).toEqual({ top: padding, bottom: padding, left: 0, right: 0 });
        },
    );
});
