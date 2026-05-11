import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstance, renderScreen, standardCleanup } from '@/dev/testkit';
import type { ReleaseNotesManifest } from '@/changelog/releaseNotes/types';

const initialManifest: ReleaseNotesManifest = {
    schemaVersion: 'v1',
    latestReleaseId: 'v2',
    generatedAt: '2026-05-10T00:00:00.000Z',
    assetBaseUrl: 'https://assets.example/',
    releases: [
        {
            releaseId: 'v2',
            versionLabel: 'v2',
            publishedAt: '2026-05-10T00:00:00.000Z',
            titleKey: 'releaseNotes.v2.title',
            cards: [{
                kind: 'list',
                titleKey: 'releaseNotes.v2.card.title',
                rows: [{ iconId: 'sparkles', titleKey: 'releaseNotes.v2.row.title', bodyKey: 'releaseNotes.v2.row.body' }],
            }],
        },
        {
            releaseId: 'v1',
            versionLabel: 'v1',
            publishedAt: '2026-05-01T00:00:00.000Z',
            titleKey: 'releaseNotes.v1.title',
            cards: [{
                kind: 'list',
                titleKey: 'releaseNotes.v1.card.title',
                rows: [{ iconId: 'rocket', titleKey: 'releaseNotes.v1.row.title', bodyKey: 'releaseNotes.v1.row.body' }],
            }],
        },
    ],
};

const manifestState = vi.hoisted(() => ({
    manifest: {
        schemaVersion: 'v1',
        latestReleaseId: 'v2',
        generatedAt: '2026-05-10T00:00:00.000Z',
        assetBaseUrl: 'https://assets.example/',
        releases: [
            {
                releaseId: 'v2',
                versionLabel: 'v2',
                publishedAt: '2026-05-10T00:00:00.000Z',
                titleKey: 'releaseNotes.v2.title',
                cards: [{
                    kind: 'list',
                    titleKey: 'releaseNotes.v2.card.title',
                    rows: [{ iconId: 'sparkles', titleKey: 'releaseNotes.v2.row.title', bodyKey: 'releaseNotes.v2.row.body' }],
                }],
            },
            {
                releaseId: 'v1',
                versionLabel: 'v1',
                publishedAt: '2026-05-01T00:00:00.000Z',
                titleKey: 'releaseNotes.v1.title',
                cards: [{
                    kind: 'list',
                    titleKey: 'releaseNotes.v1.card.title',
                    rows: [{ iconId: 'rocket', titleKey: 'releaseNotes.v1.row.title', bodyKey: 'releaseNotes.v1.row.body' }],
                }],
            },
        ],
    } as ReleaseNotesManifest,
}));

const modalMock = vi.hoisted(() => {
    const show = vi.fn<(config: unknown) => string>((config) => {
        void config;
        return 'modal-id';
    });
    const hide = vi.fn();
    return {
        spies: { show, hide },
        module: {
            Modal: {
                show,
                hide,
                update: vi.fn(),
                hideAll: vi.fn(),
                alert: vi.fn(),
                alertAsync: vi.fn(),
                prompt: vi.fn(),
                confirm: vi.fn(),
            },
            useOptionalModal: () => ({
                state: { modals: [] },
                showModal: show,
                hideModal: hide,
                hideAllModals: vi.fn(),
                updateCustomModalProps: vi.fn(),
            }),
            ModalProvider: ({ children }: { children?: React.ReactNode }) => children ?? null,
        },
    };
});

vi.mock('@/modal', () => modalMock.module);
vi.mock('@/components/changelog/releaseNotes', () => ({
    ReleaseNotesStorySurface: 'ReleaseNotesStorySurface',
}));
vi.mock('@/components/onboarding/showcase', () => ({
    OnboardingShowcaseStorySurface: 'OnboardingShowcaseStorySurface',
}));
vi.mock('@/changelog/releaseNotes', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/changelog/releaseNotes')>();
    return {
        ...actual,
        getActiveManifest: () => manifestState.manifest,
        getReleaseNotesRuntimeVersion: () => 0,
        subscribeReleaseNotesRuntime: () => () => {},
    };
});

function resetMocks() {
    modalMock.spies.show.mockClear();
    modalMock.spies.hide.mockClear();
    manifestState.manifest = initialManifest;
}

describe('StoryDeckPreviewDevSection', () => {
    beforeEach(() => {
        resetMocks();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders onboarding and one preview row per available release', async () => {
        const { StoryDeckPreviewDevSection } = await import('./StoryDeckPreviewDevSection');

        const screen = await renderScreen(<StoryDeckPreviewDevSection />);

        expect(screen.findByTestId('dev-story-deck-preview-onboarding')).toBeTruthy();
        expect(screen.findByTestId('dev-story-deck-preview-release:v2')).toBeTruthy();
        expect(screen.findByTestId('dev-story-deck-preview-release:v1')).toBeTruthy();
        expect(screen.findByTestId('dev-story-deck-preview-empty')).toBeNull();
    });

    it('opens the onboarding showcase preview without marking it seen', async () => {
        const { StoryDeckPreviewDevSection } = await import('./StoryDeckPreviewDevSection');
        const screen = await renderScreen(<StoryDeckPreviewDevSection />);

        pressTestInstance(screen.findByTestId('dev-story-deck-preview-onboarding'), 'onboarding preview');

        expect(modalMock.spies.show).toHaveBeenCalledTimes(1);
        expect(modalMock.spies.show.mock.calls[0]?.[0]).toMatchObject({
            component: 'OnboardingShowcaseStorySurface',
            props: expect.objectContaining({ testID: 'dev-onboarding-showcase-story-preview' }),
        });
    });

    it('opens a selected release-note preview without marking the release seen', async () => {
        const { StoryDeckPreviewDevSection } = await import('./StoryDeckPreviewDevSection');
        const screen = await renderScreen(<StoryDeckPreviewDevSection />);

        pressTestInstance(screen.findByTestId('dev-story-deck-preview-release:v1'), 'release preview');

        expect(modalMock.spies.show).toHaveBeenCalledTimes(1);
        expect(modalMock.spies.show.mock.calls[0]?.[0]).toMatchObject({
            component: 'ReleaseNotesStorySurface',
            props: expect.objectContaining({
                release: expect.objectContaining({ releaseId: 'v1' }),
                testID: 'dev-release-notes-story-preview:v1',
            }),
        });
    });

    it('renders an empty state when no release notes are available', async () => {
        manifestState.manifest = {
            ...manifestState.manifest,
            latestReleaseId: null,
            releases: [],
        };
        const { StoryDeckPreviewDevSection } = await import('./StoryDeckPreviewDevSection');

        const screen = await renderScreen(<StoryDeckPreviewDevSection />);

        expect(screen.findByTestId('dev-story-deck-preview-empty')).toBeTruthy();
    });
});
