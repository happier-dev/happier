// C-DOCS closure test (QA-RECONCILE-1). Reads the `.reviews/**` status markdown via an explicit
// import.meta.url-resolved absolute path and asserts STABLE-FACT doc invariants (banner presence,
// fixed-annotation presence, specific stale claims corrected) — NOT prose/wording/whitespace policing.
// It does not import product modules or run the live gate.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PRIOR_DIR = fileURLToPath(
    new URL('../../../../.reviews/2026-06-21-074357-runtime-browser-services-deep-review', import.meta.url),
);
const CURRENT_DIR = fileURLToPath(
    new URL('../../../../.reviews/2026-06-22-stabilization', import.meta.url),
);

function read(dir: string, relPath: string): string {
    return readFileSync(`${dir}/${relPath}`, 'utf8');
}

describe('C-DOCS: single status authority for the browser/services stabilization', () => {
    it('STATUS.md (current truth) exists and is the named authority', () => {
        const status = read(CURRENT_DIR, 'STATUS.md');
        expect(status).toContain('CURRENT TRUTH');
        expect(status).toContain('single live status authority');
    });

    it('all four prior docs carry a supersession banner pointing to STATUS.md', () => {
        for (const relPath of [
            'EXECUTION-LEDGER.md',
            'FINAL-REPORT.md',
            'QA-TRACKING.md',
            'packets/INDEX.md',
        ]) {
            const doc = read(PRIOR_DIR, relPath);
            expect(doc, `${relPath} must carry a supersession banner`).toContain('SUPERSEDED 2026-06-22');
            expect(doc, `${relPath} must point to STATUS.md`).toContain('STATUS.md');
        }
    });

    it('(a) EXECUTION-LEDGER no longer claims to be the live truth without retraction', () => {
        const ledger = read(PRIOR_DIR, 'EXECUTION-LEDGER.md');
        // The "live execution truth" phrase must be retracted, not left as a live claim.
        expect(ledger).toContain('RETRACTED');
        expect(ledger).toContain('SUPERSEDED 2026-06-22');
    });

    it('(b) FINAL-REPORT marks F-A and F-B as FIXED', () => {
        const report = read(PRIOR_DIR, 'FINAL-REPORT.md');
        expect(report).toContain('F-A is FIXED');
        expect(report).toContain('F-B is FIXED');
    });

    it('(c) QA-TRACKING marks SVC-2 as WIRED via the shared hook', () => {
        const tracking = read(PRIOR_DIR, 'QA-TRACKING.md');
        expect(tracking).toContain('SVC-2 is WIRED');
        expect(tracking).toContain('useServicesOpenInBrowser');
    });

    it('(d) the false "4 .test.sh GREEN" gate-green claim is corrected to the RED/BLOCKED reality', () => {
        for (const [dir, relPath] of [
            [PRIOR_DIR, 'packets/INDEX.md'],
            [PRIOR_DIR, 'packets/FP-GATE-1.md'],
        ] as const) {
            const doc = read(dir, relPath);
            // Wherever the gate-green framing appears, the RED/BLOCKED correction must be adjacent.
            expect(doc, `${relPath} must reference the RED verify-gate harness`).toContain('verify-gate.test.sh');
            expect(doc, `${relPath} must state the gate is RED/BLOCKED`).toContain('BLOCKED');
        }
    });

    it('(e) FINAL-REPORT corrects the stale "not linked" RN status to linked + device-build remainder', () => {
        const report = read(PRIOR_DIR, 'FINAL-REPORT.md');
        expect(report).toContain('ScriptManager/Re.Pack runtime IS linked');
        expect(report).toContain('device build');
    });
});
