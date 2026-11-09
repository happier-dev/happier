import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

const { CoordinationLevelsSheet } = await import('./CoordinationLevelsSheet');

afterEach(() => standardCleanup());

it('lists every level with the follow editor’s own description of it', async () => {
    const screen = await renderScreen(<CoordinationLevelsSheet onClose={() => {}} />);
    const rows = ['everything', 'important', 'quiet', 'custom'].map((level) =>
        screen.findAll((node) => node.props.testID === `settings-coordination-level-meaning-${level}` && node.props.subtitle !== undefined)[0]);
    for (const row of rows) {
        expect(row).toBeDefined();
        // The real catalog's sentence, not a missing-key echo.
        expect(String(row?.props.subtitle)).not.toMatch(/^session\.follow\./);
    }
    expect(new Set(rows.map((row) => row?.props.subtitle)).size).toBe(4);
});
