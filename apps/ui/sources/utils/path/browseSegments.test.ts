import { describe, it, expect } from 'vitest';
import {
    appendSegment,
    hasTrailingSeparator,
    inferProjectTitleFromPath,
    isAtRoot,
    isBrowsePathLikeInput,
    preferredSeparatorFor,
    splitInputIntoDirectoryAndLeaf,
    walkUpOneSegment,
} from './browseSegments';

describe('browseSegments', () => {
    describe('isBrowsePathLikeInput', () => {
        it('returns true for absolute Unix paths', () => {
            expect(isBrowsePathLikeInput('/usr/local/bin')).toBe(true);
        });

        it('returns true for tilde-prefixed paths', () => {
            expect(isBrowsePathLikeInput('~/Documents')).toBe(true);
            expect(isBrowsePathLikeInput('~')).toBe(false);
            expect(isBrowsePathLikeInput('~/')).toBe(true);
        });

        it('returns true for ./ and ../ paths', () => {
            expect(isBrowsePathLikeInput('./foo')).toBe(true);
            expect(isBrowsePathLikeInput('../bar')).toBe(true);
            expect(isBrowsePathLikeInput('./')).toBe(true);
            expect(isBrowsePathLikeInput('../')).toBe(true);
        });

        it('returns true for Windows drive paths', () => {
            expect(isBrowsePathLikeInput('C:\\Users\\foo')).toBe(true);
            expect(isBrowsePathLikeInput('C:/Users/foo')).toBe(true);
            expect(isBrowsePathLikeInput('D:\\')).toBe(true);
            expect(isBrowsePathLikeInput('z:')).toBe(true);
        });

        it('returns true for UNC paths', () => {
            expect(isBrowsePathLikeInput('\\\\server\\share\\foo')).toBe(true);
            expect(isBrowsePathLikeInput('\\\\server\\share')).toBe(true);
        });

        it('returns false for plain words and empty strings', () => {
            expect(isBrowsePathLikeInput('')).toBe(false);
            expect(isBrowsePathLikeInput('foo')).toBe(false);
            expect(isBrowsePathLikeInput('foo/bar')).toBe(false);
            expect(isBrowsePathLikeInput('hello world')).toBe(false);
        });
    });

    describe('splitInputIntoDirectoryAndLeaf', () => {
        it('returns empty dir and leaf for empty input', () => {
            expect(splitInputIntoDirectoryAndLeaf('')).toEqual({ dir: '', leaf: '' });
        });

        it('returns dir with trailing separator and leaf for typical Unix path', () => {
            expect(splitInputIntoDirectoryAndLeaf('/a/b')).toEqual({ dir: '/a/', leaf: 'b' });
        });

        it('returns full input as dir when path ends with separator', () => {
            expect(splitInputIntoDirectoryAndLeaf('/a/b/')).toEqual({ dir: '/a/b/', leaf: '' });
        });

        it('returns empty dir and full input as leaf when no separator present', () => {
            expect(splitInputIntoDirectoryAndLeaf('foo')).toEqual({ dir: '', leaf: 'foo' });
        });

        it('handles tilde-prefixed paths', () => {
            expect(splitInputIntoDirectoryAndLeaf('~/Doc')).toEqual({ dir: '~/', leaf: 'Doc' });
            expect(splitInputIntoDirectoryAndLeaf('~/Documents/lantern')).toEqual({
                dir: '~/Documents/',
                leaf: 'lantern',
            });
        });

        it('handles Windows drive paths', () => {
            expect(splitInputIntoDirectoryAndLeaf('C:\\Users\\foo')).toEqual({
                dir: 'C:\\Users\\',
                leaf: 'foo',
            });
            expect(splitInputIntoDirectoryAndLeaf('C:\\')).toEqual({ dir: 'C:\\', leaf: '' });
        });

        it('canonicalises mixed separators on Windows-shaped input', () => {
            expect(splitInputIntoDirectoryAndLeaf('C:\\Users/foo')).toEqual({
                dir: 'C:\\Users\\',
                leaf: 'foo',
            });
        });

        it('handles UNC paths', () => {
            expect(splitInputIntoDirectoryAndLeaf('\\\\server\\share\\foo')).toEqual({
                dir: '\\\\server\\share\\',
                leaf: 'foo',
            });
            expect(splitInputIntoDirectoryAndLeaf('\\\\server\\share\\')).toEqual({
                dir: '\\\\server\\share\\',
                leaf: '',
            });
        });

        it('respects explicit windows targetPlatform on Unix-shaped input', () => {
            expect(splitInputIntoDirectoryAndLeaf('a\\b', 'windows')).toEqual({
                dir: 'a\\',
                leaf: 'b',
            });
        });

        it('respects explicit unix targetPlatform on Windows-shaped input', () => {
            // Under unix mode, backslashes are not separators.
            expect(splitInputIntoDirectoryAndLeaf('C:\\Users\\foo', 'unix')).toEqual({
                dir: '',
                leaf: 'C:\\Users\\foo',
            });
        });
    });

    describe('walkUpOneSegment', () => {
        it('returns null for empty input', () => {
            expect(walkUpOneSegment('')).toBeNull();
        });

        it('returns null at Unix root', () => {
            expect(walkUpOneSegment('/')).toBeNull();
        });

        it('returns null at Windows drive root', () => {
            expect(walkUpOneSegment('C:\\')).toBeNull();
            expect(walkUpOneSegment('C:/')).toBeNull();
        });

        it('returns null at UNC root', () => {
            expect(walkUpOneSegment('\\\\server\\share\\')).toBeNull();
            expect(walkUpOneSegment('\\\\server\\share')).toBeNull();
        });

        it('walks up from a Unix file path to its directory with trailing separator', () => {
            expect(walkUpOneSegment('/a/b/c')).toBe('/a/b/');
            expect(walkUpOneSegment('/a/b/c/')).toBe('/a/b/');
        });

        it('walks up from a Windows path to its parent with trailing backslash', () => {
            expect(walkUpOneSegment('C:\\Users\\foo')).toBe('C:\\Users\\');
            expect(walkUpOneSegment('C:\\foo\\')).toBe('C:\\');
        });

        it('walks up from a UNC path to its share root', () => {
            expect(walkUpOneSegment('\\\\server\\share\\foo')).toBe('\\\\server\\share\\');
            expect(walkUpOneSegment('\\\\server\\share\\foo\\')).toBe('\\\\server\\share\\');
        });

        it('walks up tilde paths', () => {
            expect(walkUpOneSegment('~/Documents/')).toBe('~/');
            expect(walkUpOneSegment('~/Documents/lantern')).toBe('~/Documents/');
        });

        it('returns null when walking up from "~/" (effectively root for shorthand)', () => {
            expect(walkUpOneSegment('~/')).toBeNull();
        });
    });

    describe('appendSegment', () => {
        it('appends a segment with a single separator (Unix)', () => {
            expect(appendSegment('/a/b/', 'c')).toBe('/a/b/c');
            expect(appendSegment('/a/b', 'c')).toBe('/a/b/c');
        });

        it('appends a segment with a single backslash (Windows)', () => {
            expect(appendSegment('C:\\Users\\', 'foo')).toBe('C:\\Users\\foo');
            expect(appendSegment('C:\\Users', 'foo')).toBe('C:\\Users\\foo');
        });

        it('preserves shorthand tilde input', () => {
            expect(appendSegment('~/', 'Documents')).toBe('~/Documents');
            expect(appendSegment('~/Documents/', 'lantern')).toBe('~/Documents/lantern');
        });

        it('produces a path with trailing separator when appending an empty seed dir', () => {
            // Empty directory + name yields just the name (no leading separator inferred).
            expect(appendSegment('', 'foo')).toBe('foo');
        });

        it('never produces double separators when both directory ends with sep and name starts with sep', () => {
            expect(appendSegment('/a/b/', '/c')).toBe('/a/b/c');
            expect(appendSegment('C:\\Users\\', '\\foo', 'windows')).toBe('C:\\Users\\foo');
        });

        it('respects explicit windows targetPlatform when joining', () => {
            expect(appendSegment('a', 'b', 'windows')).toBe('a\\b');
        });

        it('respects explicit unix targetPlatform when joining', () => {
            expect(appendSegment('a', 'b', 'unix')).toBe('a/b');
        });

        describe("Bug 4b: directory kind appends trailing separator (so the input descends into the dir)", () => {
            it('appends a trailing slash when entry kind is directory (unix)', () => {
                // Caller passes the DIRECTORY SEED (already split via
                // splitInputIntoDirectoryAndLeaf). For input `~/Doc` the seed
                // is `~/`, and appending `Documents` as a directory yields
                // `~/Documents/` (with trailing slash so the input descends).
                expect(appendSegment('~/', 'Documents', 'unix', 'directory')).toBe('~/Documents/');
                // When the directory seed already ends with a separator.
                expect(appendSegment('/a/b/', 'c', 'unix', 'directory')).toBe('/a/b/c/');
            });

            it('does NOT append a trailing slash for file kind', () => {
                expect(appendSegment('~/', 'README.md', 'unix', 'file')).toBe('~/README.md');
                expect(appendSegment('/a/b/', 'c.txt', 'unix', 'file')).toBe('/a/b/c.txt');
            });

            it('appends a trailing backslash when entry kind is directory (windows)', () => {
                expect(appendSegment('C:\\Users\\', 'foo', 'windows', 'directory')).toBe(
                    'C:\\Users\\foo\\',
                );
                expect(appendSegment('C:\\', 'Users', 'windows', 'directory')).toBe(
                    'C:\\Users\\',
                );
            });

            it("defaults to no trailing separator when kind is omitted (back-compat)", () => {
                expect(appendSegment('~/', 'Documents')).toBe('~/Documents');
                // Without kind, `~/Doc` + `Documents` follows the original
                // join semantics (treats `~/Doc` as a complete dir name).
                expect(appendSegment('~/Doc', 'Documents', 'unix')).toBe('~/Doc/Documents');
            });
        });
    });

    describe('inferProjectTitleFromPath', () => {
        it('returns the last non-empty Unix segment', () => {
            expect(inferProjectTitleFromPath('/Users/leeroy/Documents/lantern')).toBe('lantern');
            expect(inferProjectTitleFromPath('/Users/leeroy/Documents/lantern/')).toBe('lantern');
        });

        it('returns the last non-empty Windows segment', () => {
            expect(inferProjectTitleFromPath('C:\\Users\\leeroy\\projects\\lantern')).toBe('lantern');
            expect(inferProjectTitleFromPath('C:\\Users\\leeroy\\projects\\lantern\\')).toBe('lantern');
        });

        it('returns empty string for empty input', () => {
            expect(inferProjectTitleFromPath('')).toBe('');
        });

        it('returns empty string for root-only inputs', () => {
            expect(inferProjectTitleFromPath('/')).toBe('');
            expect(inferProjectTitleFromPath('C:\\')).toBe('');
        });

        it('returns the input itself when there is no separator', () => {
            expect(inferProjectTitleFromPath('lantern')).toBe('lantern');
        });
    });

    describe('preferredSeparatorFor', () => {
        it('returns "/" for Unix-shaped input under auto', () => {
            expect(preferredSeparatorFor('/a/b/c')).toBe('/');
            expect(preferredSeparatorFor('~/foo')).toBe('/');
            expect(preferredSeparatorFor('')).toBe('/');
        });

        it('returns "\\" for Windows-shaped input under auto', () => {
            expect(preferredSeparatorFor('C:\\Users')).toBe('\\');
            expect(preferredSeparatorFor('\\\\server\\share')).toBe('\\');
        });

        it('returns "\\" when targetPlatform is windows regardless of input shape', () => {
            expect(preferredSeparatorFor('/a/b', 'windows')).toBe('\\');
            expect(preferredSeparatorFor('', 'windows')).toBe('\\');
        });

        it('returns "/" when targetPlatform is unix regardless of input shape', () => {
            expect(preferredSeparatorFor('C:\\Users', 'unix')).toBe('/');
        });
    });

    describe('hasTrailingSeparator', () => {
        it('returns true when Unix input ends with /', () => {
            expect(hasTrailingSeparator('/a/b/')).toBe(true);
            expect(hasTrailingSeparator('~/')).toBe(true);
        });

        it('returns false when Unix input does not end with /', () => {
            expect(hasTrailingSeparator('/a/b')).toBe(false);
            expect(hasTrailingSeparator('foo')).toBe(false);
            expect(hasTrailingSeparator('')).toBe(false);
        });

        it('returns true when Windows-shaped input ends with backslash', () => {
            expect(hasTrailingSeparator('C:\\Users\\')).toBe(true);
            expect(hasTrailingSeparator('\\\\server\\share\\')).toBe(true);
        });

        it('returns true when Windows-shaped input ends with forward slash', () => {
            expect(hasTrailingSeparator('C:\\Users/')).toBe(true);
        });

        it('returns true for explicit windows mode trailing backslash on Unix-shaped input', () => {
            expect(hasTrailingSeparator('a\\', 'windows')).toBe(true);
        });

        it('returns false for backslash-trailing input under explicit unix mode', () => {
            expect(hasTrailingSeparator('a\\', 'unix')).toBe(false);
        });
    });

    describe('isAtRoot', () => {
        it('returns true for Unix root /', () => {
            expect(isAtRoot('/')).toBe(true);
        });

        it('returns true for Windows drive roots', () => {
            expect(isAtRoot('C:\\')).toBe(true);
            expect(isAtRoot('C:/')).toBe(true);
            expect(isAtRoot('Z:\\')).toBe(true);
        });

        it('returns true for UNC root paths', () => {
            expect(isAtRoot('\\\\server\\share\\')).toBe(true);
            expect(isAtRoot('\\\\server\\share')).toBe(true);
        });

        it('returns false for non-root paths', () => {
            expect(isAtRoot('/a')).toBe(false);
            expect(isAtRoot('/a/')).toBe(false);
            expect(isAtRoot('C:\\Users')).toBe(false);
            expect(isAtRoot('C:\\Users\\')).toBe(false);
            expect(isAtRoot('~/')).toBe(false);
            expect(isAtRoot('')).toBe(false);
        });

        it('respects explicit unix targetPlatform (Windows roots are not root under unix)', () => {
            expect(isAtRoot('C:\\', 'unix')).toBe(false);
        });

        it('respects explicit windows targetPlatform (Unix root is not root under windows)', () => {
            expect(isAtRoot('/', 'windows')).toBe(false);
        });
    });

    describe("Bug 4d: UNC and partial Windows path handling", () => {
        describe('isBrowsePathLikeInput accepts partial windows shapes', () => {
            it('accepts partial UNC prefix `\\\\server` once a server name is typed (windows)', () => {
                expect(isBrowsePathLikeInput('\\\\server', 'windows')).toBe(true);
            });

            it('accepts a lone double-backslash prefix as path-like under windows', () => {
                expect(isBrowsePathLikeInput('\\\\', 'windows')).toBe(true);
            });

            it('treats forward-slash drive paths as path-like (mixed slashes valid on windows)', () => {
                expect(isBrowsePathLikeInput('C:/Users/foo')).toBe(true);
                expect(isBrowsePathLikeInput('c:/', 'windows')).toBe(true);
            });
        });

        describe('isAtRoot: drive-only `C:` is NOT root (no trailing separator)', () => {
            it('returns false for `C:` without trailing separator', () => {
                expect(isAtRoot('C:')).toBe(false);
                expect(isAtRoot('C:', 'windows')).toBe(false);
            });

            it('returns true for `C:\\` and `C:/`', () => {
                expect(isAtRoot('C:\\')).toBe(true);
                expect(isAtRoot('C:/')).toBe(true);
            });
        });

        describe('walkUpOneSegment with partial UNC input', () => {
            it('does not return a parent above the UNC share root', () => {
                expect(walkUpOneSegment('\\\\server\\share\\foo\\bar')).toBe('\\\\server\\share\\foo\\');
                expect(walkUpOneSegment('\\\\server\\share\\foo')).toBe('\\\\server\\share\\');
            });
        });
    });

    describe('idempotency: walkUpOneSegment(appendSegment(seed, name)) returns to seed', () => {
        it('round-trips Unix shorthand seed', () => {
            const seed = '~/';
            expect(walkUpOneSegment(appendSegment(seed, 'Documents'))).toBe(seed);
        });

        it('round-trips Unix absolute seed', () => {
            const seed = '/a/b/';
            expect(walkUpOneSegment(appendSegment(seed, 'c'))).toBe(seed);
        });

        it('round-trips Windows seed', () => {
            const seed = 'C:\\Users\\';
            expect(walkUpOneSegment(appendSegment(seed, 'foo'))).toBe(seed);
        });

        it('round-trips UNC seed', () => {
            const seed = '\\\\server\\share\\';
            expect(walkUpOneSegment(appendSegment(seed, 'foo'))).toBe(seed);
        });
    });
});
