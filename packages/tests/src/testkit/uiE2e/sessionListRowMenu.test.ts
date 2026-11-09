import { describe, expect, it, vi } from 'vitest';

const { playwrightExpect } = vi.hoisted(() => ({
    playwrightExpect: Object.assign(
        vi.fn((locator: { count: () => Promise<number> }) => ({
            async toHaveCount(expectedCount: number): Promise<void> {
                expect(await locator.count()).toBe(expectedCount);
            },
        })),
        {
            poll: vi.fn(),
        },
    ),
}));

vi.mock('@playwright/test', () => ({
    expect: playwrightExpect,
}));

import { openSessionListRowMenu } from './sessionListRowMenu';
import { sessionListRowTestId } from './sessionListRowTestId';

type FakeLocator = {
    count: () => Promise<number>;
    click: ReturnType<typeof vi.fn>;
    hover?: ReturnType<typeof vi.fn>;
    waitFor?: (options: Readonly<{ state: string }>) => Promise<void>;
    getByTestId?: (testId: string) => FakeLocator;
    locator?: (selector: string) => FakeLocator;
    getByRole?: (role: string, options: Readonly<{ name: RegExp }>) => FakeLocator;
};

describe('openSessionListRowMenu', () => {
    it.each(['home-a', 'home-b'])('opens the qualified base occurrence on %s after hovering it', async (serverId) => {
        let hoverActive = false;

        const trigger: FakeLocator = {
            count: async () => (hoverActive ? 1 : 0),
            waitFor: async (options) => {
                expect(options.state).toBe('visible');
                expect(hoverActive).toBe(true);
            },
            click: vi.fn(async () => {}),
        };

        const fallbackRoleButton: FakeLocator = {
            count: async () => 0,
            click: vi.fn(async () => {}),
        };

        const row: FakeLocator = {
            count: async () => 1,
            click: vi.fn(async () => {}),
            hover: vi.fn(async () => {
                hoverActive = true;
            }),
            // The navigation target and hover controls are siblings in the row.
            locator: () => {
                return {
                    count: async () => 1,
                    click: vi.fn(),
                    getByTestId: (testId: string) => {
                        expect(testId).toBe('session-item-more-menu');
                        return trigger;
                    },
                };
            },
            getByRole: (role: string, options: Readonly<{ name: RegExp }>) => {
                expect(role).toBe('button');
                expect(options.name.test('more actions')).toBe(true);
                return fallbackRoleButton;
            },
        };

        const page = {
            getByTestId: vi.fn((testId: string) => {
                expect(testId).toBe(sessionListRowTestId(serverId, 'session-1'));
                return row;
            }),
        };

        await openSessionListRowMenu(page as never, { serverId, sessionId: 'session-1' });

        expect(row.hover).toHaveBeenCalledTimes(1);
        expect(trigger.click).toHaveBeenCalledTimes(1);
        expect(fallbackRoleButton.click).not.toHaveBeenCalled();
    });
});
