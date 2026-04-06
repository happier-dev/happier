import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';

describe('DesktopSettingsEntry web variant', () => {
    it('renders a web-safe no-op entry', async () => {
        const { DesktopSettingsEntry } = await import('./DesktopSettingsEntry.web');
        const screen = await renderSettingsView(React.createElement(DesktopSettingsEntry));

        expect(screen.tree.toJSON()).toBeNull();
    });
});
