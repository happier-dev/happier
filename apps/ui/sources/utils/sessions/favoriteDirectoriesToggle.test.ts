import { describe, expect, it } from 'vitest';

import { toggleHomeAwareDirectoryFavorite } from './favoriteDirectoriesToggle';

describe('toggleHomeAwareDirectoryFavorite', () => {
    it('removes a stored home-relative favorite when toggled from an absolute path', () => {
        const next = toggleHomeAwareDirectoryFavorite(
            ['~/src/app'],
            '/Users/alice/src/app',
            '/Users/alice',
        );

        expect(next).toEqual([]);
    });

    it('preserves the provided path form when adding a new favorite', () => {
        const next = toggleHomeAwareDirectoryFavorite(
            ['/Users/alice/notes'],
            '~/src/app',
            '/Users/alice',
        );

        expect(next).toEqual(['/Users/alice/notes', '~/src/app']);
    });

    it('removes all stored entries that resolve to the same directory', () => {
        const next = toggleHomeAwareDirectoryFavorite(
            ['~/src/app', '/Users/alice/src/app', '~/src/other'],
            '/Users/alice/src/app',
            '/Users/alice',
        );

        expect(next).toEqual(['~/src/other']);
    });

    it('matches Windows home-relative favorites across separators and drive casing', () => {
        const next = toggleHomeAwareDirectoryFavorite(
            ['~\\src\\app', 'C:\\Users\\Alice\\src\\app', 'C:/Users/Alice/src/other'],
            'c:/users/alice/src/app',
            'C:\\Users\\Alice',
        );

        expect(next).toEqual(['C:/Users/Alice/src/other']);
    });

    it('does not treat a Windows home sibling prefix as the same favorite', () => {
        const next = toggleHomeAwareDirectoryFavorite(
            ['~\\src\\app'],
            'C:/Users/Alice2/src/app',
            'C:\\Users\\Alice',
        );

        expect(next).toEqual(['~\\src\\app', 'C:/Users/Alice2/src/app']);
    });

    it('drops malformed stored favorite values instead of throwing', () => {
        const next = toggleHomeAwareDirectoryFavorite(
            ['~/src/app', 12, null],
            '/Users/alice/src/app',
            '/Users/alice',
        );

        expect(next).toEqual([]);
    });
});
