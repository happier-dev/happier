import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';

import { createSessionListSpaceChromeFixture } from './sessionListSpaceChromeTestFixture';
import { createSessionListViewFilterDefaults } from './sessionListViewFilters';
import type { SessionListViewFilterController } from './useSessionListViewFilterController';

const editorControlSpy = vi.fn();

vi.mock('./SessionListFilterEditorControl', () => ({
    SessionListFilterEditorControl: (props: Readonly<Record<string, unknown>>) => {
        editorControlSpy(props);
        return React.createElement('SessionListFilterEditorControl', props);
    },
}));

afterEach(() => {
    standardCleanup();
    editorControlSpy.mockClear();
});

function controller(
    overrides: Partial<SessionListViewFilterController> = {},
): SessionListViewFilterController {
    const filters = createSessionListViewFilterDefaults({ homeServerIds: ['home-a'] });
    return {
        filters,
        defaultFilters: filters,
        contextDefaultFilters: filters,
        updateFilters: vi.fn(),
        setSearchQuery: vi.fn(),
        removeAuthoritativelyDeletedSelections: vi.fn(),
        resetFilters: vi.fn(),
        showCoordinatorsRequest: 0, acknowledgeShowCoordinatorsRequest: vi.fn(),
        includeInactive: true,
        corpusStorage: 'active',
        setIncludeInactive: vi.fn(),
        setSource: vi.fn(),
        queryEnabled: false,
        corpusPresentation: 'legacy_owner_or_direct',
        queryHomes: [],
        pagingHomes: undefined,
        followingAvailable: false,
        sourceAvailable: false,
        homeOptions: [{ serverId: 'home-a', label: 'Home A' }],
        viewContext: { kind: 'global' },
        viewContextKey: 'global',
        retentionScopeKey: 'global:home-a',
        spaces: [], selectedSpaceId: 'my-work', selectedSpace: null, spacesReady: false,
        activeSpace: null, spacesEnabled: false,
        spaceSettingsScope: null, includeNeedsYouEverywhere: false, isSpaceModified: false,
        ...overrides,
        displayFilters: overrides.displayFilters ?? overrides.filters ?? filters,
    };
}

describe('SessionListFilterControl legacy corpus presentation', () => {
    it('labels the released owner/direct corpus truthfully and exposes no semantic query scopes', async () => {
        const { SessionListFilterControl } = await import('./SessionListFilterControl');
        await renderScreen(
            <SessionListFilterControl spaceChrome={createSessionListSpaceChromeFixture()}
                controller={controller()}
                organizationProjectionsByServerId={{}}
            />,
        );

        const props = editorControlSpy.mock.lastCall?.[0] as Readonly<{
            label: string;
            editor: Readonly<{ queryEnabled: boolean }>;
        }>;
        // The legacy corpus is named by its own declared label, never by the semantic scope's (copy: 93cdda7854
        // set the shared catalog's legacy wording to "My work"; this pins the key, not the words).
        expect(props.label).toBe(t('sessionsList.filtersLegacyOwnerDirect'));
        expect(props.editor.queryEnabled).toBe(false);
    });

    it('retains My work and semantic query scopes when exact filtered listing is available', async () => {
        const { SessionListFilterControl } = await import('./SessionListFilterControl');
        await renderScreen(
            <SessionListFilterControl spaceChrome={createSessionListSpaceChromeFixture()}
                controller={controller({ queryEnabled: true, corpusPresentation: 'semantic_query' })}
                organizationProjectionsByServerId={{}}
            />,
        );

        const props = editorControlSpy.mock.lastCall?.[0] as Readonly<{
            label: string;
            editor: Readonly<{ queryEnabled: boolean }>;
        }>;
        expect(props.label).toBe('My work');
        expect(props.editor.queryEnabled).toBe(true);
    });

    it('names the attention scope in the collapsed control label', async () => {
        const { SessionListFilterControl } = await import('./SessionListFilterControl');
        const base = createSessionListViewFilterDefaults({ homeServerIds: ['home-a'] });
        await renderScreen(
            <SessionListFilterControl spaceChrome={createSessionListSpaceChromeFixture()}
                controller={controller({
                    queryEnabled: true,
                    corpusPresentation: 'semantic_query',
                    filters: { ...base, attention: 'needs_my_attention' },
                })}
                organizationProjectionsByServerId={{}}
            />,
        );

        const props = editorControlSpy.mock.lastCall?.[0] as Readonly<{ label: string; active: boolean }>;
        // The collapsed chrome is the only place a compact host can say which facet
        // shortened the list, and it is the control's accessible name as well.
        expect(props.label).toBe('My work · Needs me');
        expect(props.active).toBe(true);
    });

    it('hands the Archived destination to the scope menu and reads the scope from the label, not the narrowed mark', async () => {
        const { SessionListFilterControl } = await import('./SessionListFilterControl');
        const openArchived = vi.fn();
        const base = createSessionListViewFilterDefaults({ homeServerIds: ['home-a'] });
        await renderScreen(
            <SessionListFilterControl spaceChrome={createSessionListSpaceChromeFixture()}
                controller={controller({
                    queryEnabled: true,
                    corpusPresentation: 'semantic_query',
                    filters: { ...base, scope: 'all_accessible' },
                })}
                organizationProjectionsByServerId={{}}
                onOpenArchived={openArchived}
            />,
        );

        const props = editorControlSpy.mock.lastCall?.[0] as Readonly<{
            label: string;
            active: boolean;
            editor: Readonly<{ onOpenArchived?: () => void; labels: Readonly<{ archived?: string }> }>;
        }>;
        expect(props.editor.onOpenArchived).toBe(openArchived);
        expect(props.editor.labels.archived).toBeTruthy();
        // A broader scope is already said by the label; "narrowed" is for facets beyond it.
        expect(props.active).toBe(false);
    });

    it('marks the inactive preference unavailable for the archived corpus', async () => {
        const { SessionListFilterControl } = await import('./SessionListFilterControl');
        await renderScreen(
            <SessionListFilterControl spaceChrome={createSessionListSpaceChromeFixture()}
                controller={controller({ corpusStorage: 'archived' })}
                organizationProjectionsByServerId={{}}
            />,
        );

        const props = editorControlSpy.mock.lastCall?.[0] as Readonly<{
            editor: Readonly<{ inactiveVisibilityAvailable: boolean }>;
        }>;
        expect(props.editor.inactiveVisibilityAvailable).toBe(false);
    });
});
