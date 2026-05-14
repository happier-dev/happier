import { describe, it, expect } from 'vitest';
import { makePathBrowseInputBehavior } from './browseInputBehavior';

describe('makePathBrowseInputBehavior', () => {
    describe('default options (auto target platform)', () => {
        const behavior = makePathBrowseInputBehavior();

        it('exposes the five expected adapter functions', () => {
            expect(typeof behavior.getFilterQueryFromInput).toBe('function');
            expect(typeof behavior.getDynamicSectionSeed).toBe('function');
            expect(typeof behavior.onBackspaceAtEnd).toBe('function');
            expect(typeof behavior.shouldSuppressAutocomplete).toBe('function');
            expect(typeof behavior.onBackUp).toBe('function');
        });

        it('extracts the leaf as the filter query for Unix-shaped input', () => {
            expect(behavior.getFilterQueryFromInput!('~/Doc')).toBe('Doc');
            expect(behavior.getFilterQueryFromInput!('/a/b')).toBe('b');
        });

        it('extracts the directory as the dynamic section seed', () => {
            expect(behavior.getDynamicSectionSeed!('~/Doc')).toBe('~/');
            expect(behavior.getDynamicSectionSeed!('/a/b/c')).toBe('/a/b/');
        });

        it('walks up one segment on backspace at end when path ends with separator', () => {
            // Trailing-separator gate (Issue 5): walk-up only runs when the
            // user has committed the directory (trailing /). Mid-typed leaves
            // fall through to native single-character delete (return null →
            // event NOT consumed by the keyboard handler).
            expect(behavior.onBackspaceAtEnd!('~/Documents/')).toBe('~/');
            expect(behavior.onBackspaceAtEnd!('/a/b/c/')).toBe('/a/b/');
            expect(behavior.onBackspaceAtEnd!('~/')).toBeNull();
        });

        it('returns null mid-typed (no trailing separator) so Backspace deletes one char natively', () => {
            // Issue 5: typing `~/Documents/dev` — Backspace must produce `~/Documents/de`
            // by letting the browser handle a single-char delete, NOT by walking up.
            expect(behavior.onBackspaceAtEnd!('~/Documents/dev')).toBeNull();
            expect(behavior.onBackspaceAtEnd!('~/Documents/lantern')).toBeNull();
            expect(behavior.onBackspaceAtEnd!('/a/b')).toBeNull();
            expect(behavior.onBackspaceAtEnd!('~/Doc')).toBeNull();
        });

        describe('onBackUp (RUX-13 — Shift+Tab walk-up regardless of trailing separator)', () => {
            it('walks up one segment when input has a trailing separator', () => {
                expect(behavior.onBackUp!('~/Documents/')).toBe('~/');
                expect(behavior.onBackUp!('/a/b/c/')).toBe('/a/b/');
            });

            it('walks up one segment even WITHOUT a trailing separator (more aggressive than Backspace)', () => {
                // Distinct from `onBackspaceAtEnd`: Shift+Tab is an explicit
                // user intent to back up, so it walks up regardless of whether
                // the path ends with a separator.
                expect(behavior.onBackUp!('~/Documents/dev')).toBe('~/Documents/');
                expect(behavior.onBackUp!('/a/b/c')).toBe('/a/b/');
                expect(behavior.onBackUp!('~/Doc')).toBe('~/');
            });

            it('returns null at Unix root', () => {
                expect(behavior.onBackUp!('/')).toBeNull();
            });

            it('returns null at home shorthand `~/`', () => {
                expect(behavior.onBackUp!('~/')).toBeNull();
            });

            it('returns null when input is empty', () => {
                expect(behavior.onBackUp!('')).toBeNull();
            });
        });
    });

    describe('shouldSuppressAutocomplete predicate covers all path-domain rules', () => {
        const behavior = makePathBrowseInputBehavior();

        it('suppresses on trailing forward slash (Unix)', () => {
            expect(behavior.shouldSuppressAutocomplete!('/a/b/')).toBe(true);
            expect(behavior.shouldSuppressAutocomplete!('~/')).toBe(true);
        });

        it('suppresses on trailing backslash for Windows-shaped input', () => {
            expect(behavior.shouldSuppressAutocomplete!('C:\\Users\\')).toBe(true);
        });

        it('suppresses at Unix root', () => {
            expect(behavior.shouldSuppressAutocomplete!('/')).toBe(true);
        });

        it('suppresses at Windows drive root', () => {
            expect(behavior.shouldSuppressAutocomplete!('C:\\')).toBe(true);
            expect(behavior.shouldSuppressAutocomplete!('C:/')).toBe(true);
        });

        it('suppresses at UNC root', () => {
            expect(behavior.shouldSuppressAutocomplete!('\\\\server\\share\\')).toBe(true);
            expect(behavior.shouldSuppressAutocomplete!('\\\\server\\share')).toBe(true);
        });

        it('does not suppress mid-segment input', () => {
            expect(behavior.shouldSuppressAutocomplete!('~/Doc')).toBe(false);
            expect(behavior.shouldSuppressAutocomplete!('/a/b')).toBe(false);
            expect(behavior.shouldSuppressAutocomplete!('C:\\Users')).toBe(false);
        });
    });

    describe('explicit targetPlatform: "windows"', () => {
        const behavior = makePathBrowseInputBehavior({ targetPlatform: 'windows' });

        it('treats backslash-trailing input as having a trailing separator on Unix-shaped strings', () => {
            // Under windows mode, even strings without drive prefix treat backslash as a sep.
            expect(behavior.shouldSuppressAutocomplete!('a\\')).toBe(true);
        });

        it('uses backslash-aware splitting in the filter/seed extraction', () => {
            expect(behavior.getFilterQueryFromInput!('a\\b')).toBe('b');
            expect(behavior.getDynamicSectionSeed!('a\\b')).toBe('a\\');
        });

        it('onBackUp returns null at Windows drive root', () => {
            expect(behavior.onBackUp!('C:\\')).toBeNull();
        });

        it('onBackUp walks up one Windows segment regardless of trailing separator', () => {
            expect(behavior.onBackUp!('C:\\Users\\Leeroy')).toBe('C:\\Users\\');
            expect(behavior.onBackUp!('C:\\Users\\Leeroy\\')).toBe('C:\\Users\\');
        });
    });

    describe('explicit targetPlatform: "unix"', () => {
        const behavior = makePathBrowseInputBehavior({ targetPlatform: 'unix' });

        it('does not treat Windows roots as suppression triggers', () => {
            expect(behavior.shouldSuppressAutocomplete!('C:\\')).toBe(false);
        });

        it('does not treat trailing backslash as a separator', () => {
            expect(behavior.shouldSuppressAutocomplete!('a\\')).toBe(false);
        });

        it('still suppresses at Unix root', () => {
            expect(behavior.shouldSuppressAutocomplete!('/')).toBe(true);
        });
    });
});
