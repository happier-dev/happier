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

type FakeLocator = {
    count: () => Promise<number>;
    click: ReturnType<typeof vi.fn>;
    hover?: ReturnType<typeof vi.fn>;
    getByTestId?: (testId: string) => FakeLocator;
    getByRole?: (role: string, options: Readonly<{ name: RegExp }>) => FakeLocator;
};

describe('openSessionListRowMenu', () => {
    it('hovers the row before opening the hover-revealed more-actions trigger', async () => {
        let hoverActive = false;

        const trigger: FakeLocator = {
            count: async () => (hoverActive ? 1 : 0),
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
            getByTestId: (testId: string) => {
                expect(testId).toBe('session-item-more-menu');
                return trigger;
            },
            getByRole: (role: string, options: Readonly<{ name: RegExp }>) => {
                expect(role).toBe('button');
                expect(options.name.test('more actions')).toBe(true);
                return fallbackRoleButton;
            },
        };

        const page = {
            getByTestId: vi.fn((testId: string) => {
                expect(testId).toBe('session-list-item-session-1');
                return row;
            }),
        };

        await openSessionListRowMenu(page as never, 'session-1');

        expect(row.hover).toHaveBeenCalledTimes(1);
        expect(trigger.click).toHaveBeenCalledTimes(1);
        expect(fallbackRoleButton.click).not.toHaveBeenCalled();
    });
});
