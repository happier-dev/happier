import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installTerminalRouteCommonModuleMocks, initializeTerminalRouteRuntimeForTests } from './terminal/terminalRouteTestHelpers';

installTerminalRouteCommonModuleMocks();
await initializeTerminalRouteRuntimeForTests();
const ChangelogScreen = (await import('@/app/(app)/changelog')).default;
const { getChangelogEntries } = await import('@/changelog');
const { MarkdownView } = await import('@/components/markdown/MarkdownView');

describe('ChangelogScreen', () => {
    const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;

    beforeEach(() => {
        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
    });

    afterEach(async () => {
        await standardCleanup();
        if (previousDeny === undefined) {
            delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        } else {
            process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('renders one MarkdownView per changelog entry', async () => {
        const entries = getChangelogEntries();
        expect(entries.length).toBeGreaterThan(0);
        const screen = await renderScreen(React.createElement(ChangelogScreen));
        expect(screen.findAllByType(MarkdownView).map((view) => view.props.markdown)).toEqual(
            entries.filter((entry) => entry.markdown).map((entry) => entry.markdown),
        );
    });

    it('offers Ask Happier about each release beside that release', async () => {
        const entries = getChangelogEntries();
        const screen = await renderScreen(React.createElement(ChangelogScreen));
        for (const entry of entries) {
            expect(screen.findByTestId(`changelog-ask-happier-${entry.id}`)).toBeTruthy();
        }
    });
});
