import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(here, '../../../../');
const sourcesRoot = path.join(uiRoot, 'sources');

/**
 * Guard for D2-revised: the browser is a CONSUMER of the single details-workspace tab engine.
 * The bespoke `BrowserTabStrip` and the parallel browser ordering authority
 * (`orderedViewIdsBySessionId` / `focusedViewIdBySessionId` / `selectBrowserTabs` /
 * `selectFocusedBrowserView`) must be gone with zero non-test importers — there is exactly one
 * tab system, host-owned.
 */
function ripgrepNonTest(pattern: string): string {
    try {
        const out = execFileSync(
            'rg',
            [
                '-n',
                pattern,
                sourcesRoot,
                '--glob',
                '!**/*.test.*',
                '--glob',
                '!**/__tests__/**',
            ],
            { encoding: 'utf8' },
        );
        return out.trim();
    } catch (error) {
        // ripgrep exits non-zero with no output when there are no matches — that is success here.
        const status = (error as { status?: number }).status;
        const stdout = (error as { stdout?: string }).stdout ?? '';
        if (status === 1 && stdout.trim().length === 0) {
            return '';
        }
        throw error;
    }
}

describe('BrowserTabStrip retirement', () => {
    it('removes the bespoke BrowserTabStrip file', () => {
        expect(existsSync(path.join(sourcesRoot, 'components/browser/BrowserTabStrip.tsx'))).toBe(false);
    });

    it('has zero non-test importers of BrowserTabStrip', () => {
        expect(ripgrepNonTest('BrowserTabStrip')).toBe('');
    });

    it('has zero non-test references to the retired browser ordering authority', () => {
        expect(ripgrepNonTest('selectBrowserTabs')).toBe('');
        expect(ripgrepNonTest('selectFocusedBrowserView')).toBe('');
        expect(ripgrepNonTest('orderedViewIdsBySessionId')).toBe('');
        expect(ripgrepNonTest('focusedViewIdBySessionId')).toBe('');
    });
});
