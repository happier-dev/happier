import * as React from 'react';
import { vi } from 'vitest';

import type { SessionListSpaceChrome } from './useSessionListSpaceChrome';

/** A column's space chrome with inert entry points, for tests of the controls it feeds. */
export function createSessionListSpaceChromeFixture(overrides: Partial<SessionListSpaceChrome> = {}): SessionListSpaceChrome {
    return {
        navigation: {
            selectSpace: vi.fn(() => true),
            selectOrdinal: vi.fn(() => true),
            selectRelative: vi.fn(() => true),
            filterOpenRequested: false,
            acknowledgeFilterOpenRequest: vi.fn(),
        },
        anchorRef: { current: null },
        filterOpen: false,
        setFilterOpen: vi.fn(),
        activeCount: 0,
        strip: null,
        filterTokens: null,
        overlays: React.createElement(React.Fragment),
        openSaveAs: vi.fn(),
        openEdit: vi.fn(),
        saveChanges: vi.fn(),
        spaceSwipe: undefined,
        ...overrides,
    };
}
