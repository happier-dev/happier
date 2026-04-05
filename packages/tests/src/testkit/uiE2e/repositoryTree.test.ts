import { describe, expect, it, vi } from 'vitest';
import type { Locator } from '@playwright/test';

import { repositoryTreeRowLocator } from './repositoryTree';

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
}

function createScope(): Readonly<{
    scope: Locator;
    locatorSpy: ReturnType<typeof vi.fn>;
    getByTextSpy: ReturnType<typeof vi.fn>;
}> {
    const locatorSpy = vi.fn((selector: string) => new FakeLocator(`locator:${selector}`));
    const getByTextSpy = vi.fn((text: string, options?: { exact?: boolean }) => new FakeLocator(`text:${text}:${options?.exact === true}`));
    return {
        // Test boundary: repositoryTreeRowLocator only touches `locator`, `getByText`, `or`, `first`, and `locator(...)`.
        scope: {
            locator: locatorSpy,
            getByText: getByTextSpy,
        } as unknown as Locator,
        locatorSpy,
        getByTextSpy,
    };
}

describe('repositoryTreeRowLocator', () => {
    it('adds exact-text fallbacks for both path variants when test ids are missing on web hosts', () => {
        const { scope, getByTextSpy } = createScope();

        repositoryTreeRowLocator(scope, 'upload-source.txt');

        expect(getByTextSpy).toHaveBeenCalledWith('upload-source.txt', { exact: true });
        expect(getByTextSpy).toHaveBeenCalledWith('upload-source.txt/', { exact: true });
    });

    it('normalizes trailing slash variants for text fallbacks', () => {
        const { scope, getByTextSpy } = createScope();

        repositoryTreeRowLocator(scope, 'download-me/');

        expect(getByTextSpy).toHaveBeenCalledWith('download-me/', { exact: true });
        expect(getByTextSpy).toHaveBeenCalledWith('download-me', { exact: true });
    });

    it('collapses combined test-id and text fallback matches to a single locator', () => {
        const { scope } = createScope();

        const locator = repositoryTreeRowLocator(scope, 'upload-source.txt') as unknown as FakeLocator;

        expect(locator.label.startsWith('first(')).toBe(true);
        expect(locator.label).toContain('repository-tree-row-upload-source.txt');
        expect(locator.label).toContain('first(text:upload-source.txt:true)');
        expect(locator.label).toContain('first(text:upload-source.txt/:true)');
    });
});
