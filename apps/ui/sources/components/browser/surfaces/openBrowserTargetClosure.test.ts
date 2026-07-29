import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * OWNER-OPEN closure (DV-OPEN-SEAM). Two guardrails:
 *
 * A. A single-view `browser-view` tab is built ONLY through the canonical workspace owner — i.e.
 *    `createBrowserViewDetailsTab` (the tab builder the opener uses) has no production caller outside
 *    `openBrowserTargetInWorkspace.ts` and the surfaces barrel re-export. New-tab opens and
 *    identity-preserving in-place retargets are distinct operations, but both must construct their
 *    resources behind that owner so a renderer cannot re-introduce a split-brain tab path.
 *
 * B. No code attaches a materialized `BrowserViewState`/`seededState` object onto a `browser-view`
 *    tab resource — that is the divergent second content path DV-OPEN-SEAM forbids. The resource
 *    must carry only the deterministic inputs (`target` + identity); the live record is derived once
 *    at the renderer.
 */
const SOURCES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function grep(pattern: string, paths: string): string {
    try {
        return execSync(`grep -rn --include='*.ts' --include='*.tsx' -- ${pattern} ${paths}`, {
            cwd: SOURCES_ROOT,
            encoding: 'utf8',
        });
    } catch (error) {
        // grep exits 1 when there are no matches.
        const status = (error as { status?: number }).status;
        if (status === 1) {
            return '';
        }
        throw error;
    }
}

describe('OWNER-OPEN closure: one atomic open path', () => {
    it('A: createBrowserViewDetailsTab has no production caller outside the canonical workspace owner/barrel', () => {
        const hits = grep("'createBrowserViewDetailsTab'", 'components sync')
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .filter((line) => !line.includes('.test.'))
            // The definition + the canonical opener + the surfaces barrel re-export are allowed.
            .filter((line) => !line.includes('browserSurfaceDetailsTabModel.ts'))
            .filter((line) => !line.includes('openBrowserTargetInWorkspace.ts'))
            .filter((line) => !line.includes('surfaces/index.ts'));
        expect(hits).toEqual([]);
    });

    it('B: no code stashes a BrowserViewState/seededState object onto a browser-view tab resource', () => {
        // A `resource: { kind: 'browser-view', ... seededState ... }` would be the banned blob. We scan
        // for any `seededState:` object-literal assignment in browser production code (the resolver
        // returns it as a value but never writes it onto a resource).
        // `seededState` is the materializability PROOF the pure resolver RETURNS (a value, derived
        // byte-for-byte the way the renderer derives the live record). It is confined to
        // `openBrowserTargetInWorkspace.ts`. Any occurrence elsewhere in browser production code would
        // be a write onto a resource / a persisted blob — the divergent second content path.
        const hits = grep("'seededState'", 'components/browser sync/domains/browser')
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .filter((line) => !line.includes('.test.'))
            .filter((line) => !line.includes('openBrowserTargetInWorkspace.ts'));
        expect(hits).toEqual([]);
    });
});
