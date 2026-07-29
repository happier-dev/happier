import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    rowReady: false,
    menuReady: false,
    menuClicked: false,
    optionClicked: false,
}));

class FakeLocator {
    public constructor(readonly label: string) {}

    public or(other: FakeLocator): FakeLocator {
        return new FakeLocator(`${this.label}.or(${other.label})`);
    }

    public first(): FakeLocator {
        return new FakeLocator(`first(${this.label})`);
    }

    public locator(selector: string): FakeLocator {
        return new FakeLocator(`${this.label}.locator(${selector})`);
    }

    public getByText(text: string): FakeLocator {
        return new FakeLocator(`${this.label}.text(${text})`);
    }

    public getByTitle(title: string): FakeLocator {
        return new FakeLocator(`${this.label}.title(${title})`);
    }

    public getByRole(role: string, options?: { name?: RegExp }): FakeLocator {
        return new FakeLocator(`${this.label}.role(${role}:${String(options?.name)})`);
    }

    public async count(): Promise<number> {
        if (this.label.includes('repository-tree-row-menu-upload-source.txt')) {
            return state.menuReady ? 1 : 0;
        }
        if (this.label.includes('dropdown-option-repository-tree-menuitem-download')) {
            return state.menuReady ? 1 : 0;
        }
        return 0;
    }

    public async click(): Promise<void> {
        if (this.label.includes('repository-tree-row-menu-upload-source.txt')) {
            state.menuClicked = true;
            return;
        }
        if (this.label.includes('dropdown-option-repository-tree-menuitem-download')) {
            state.optionClicked = true;
            return;
        }
        throw new Error(`unexpected click: ${this.label}`);
    }
}

vi.mock('@playwright/test', () => ({
    expect: (locator: FakeLocator) => ({
        toHaveCount: async (count: number) => {
            if (count === 1 && locator.label.includes('repository-tree-row-upload-source.txt')) {
                state.rowReady = true;
                state.menuReady = true;
                return;
            }
            throw new Error(`locator did not become ready: ${locator.label}`);
        },
    }),
}));

describe('openRepositoryTreeRowMenuAndSelectItem', () => {
    beforeEach(() => {
        state.rowReady = false;
        state.menuReady = false;
        state.menuClicked = false;
        state.optionClicked = false;
    });

    it('waits for a newly-created row before choosing the row-menu path', async () => {
        const { openRepositoryTreeRowMenuAndSelectItem } = await import('./repositoryTree');
        const scope = {
            locator: (selector: string) => new FakeLocator(`scope.locator(${selector})`),
            getByText: (text: string) => new FakeLocator(`scope.text(${text})`),
        };
        const page = {
            locator: (selector: string) => new FakeLocator(`page.locator(${selector})`),
        };

        await openRepositoryTreeRowMenuAndSelectItem({
            page: page as never,
            scope: scope as never,
            path: 'upload-source.txt',
            itemId: 'repository-tree-menuitem-download',
            timeoutMs: 5_000,
        });

        expect(state.rowReady).toBe(true);
        expect(state.menuClicked).toBe(true);
        expect(state.optionClicked).toBe(true);
    });
});
