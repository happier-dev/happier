// C-MATRIX closure test (QA-RECONCILE-1). Reads the canonical LIVE-FLOW-MATRIX.md via an explicit
// import.meta.url-resolved absolute path and asserts STABLE-FACT invariants: all 6 master-§3 flow ids
// exist, the shared acceptance-evidence format block exists, and the matrix is the single canonical
// owner. It does not import product modules.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STABILIZATION_DIR = fileURLToPath(
    new URL('../../../../.reviews/2026-06-22-stabilization', import.meta.url),
);

function read(relPath: string): string {
    return readFileSync(`${STABILIZATION_DIR}/${relPath}`, 'utf8');
}

describe('C-MATRIX: single canonical live-flow acceptance matrix', () => {
    const matrix = read('LIVE-FLOW-MATRIX.md');

    it('LIVE-FLOW-MATRIX.md declares itself the single canonical acceptance matrix', () => {
        expect(matrix).toContain('single canonical end-to-end acceptance matrix');
        expect(matrix).toContain('single definition of the shared acceptance-evidence format');
    });

    it('defines all 6 canonical flows (LF-1..LF-6)', () => {
        for (const flowId of ['LF-1', 'LF-2', 'LF-3', 'LF-4', 'LF-5', 'LF-6']) {
            expect(matrix, `matrix must define ${flowId}`).toContain(flowId);
        }
    });

    it('includes the shared acceptance-evidence format block', () => {
        for (const field of [
            'FLOW:',
            'SURFACE: web | tauri',
            'BUILD:',
            'STEPS RUN:',
            'EXPECTED:',
            'OBSERVED:',
            'EVIDENCE:',
            'RESULT: PASS | FAIL',
        ]) {
            expect(matrix, `evidence format must include "${field}"`).toContain(field);
        }
    });

    it('requires BOTH web AND Tauri-DEV capture (DV-TAURI-QA)', () => {
        expect(matrix).toContain('DV-TAURI-QA');
        expect(matrix).toContain('Tauri DEV');
    });

    it('STATUS.md references the matrix as the canonical owner (no competing evidence format)', () => {
        const status = read('STATUS.md');
        expect(status).toContain('LIVE-FLOW-MATRIX.md');
    });
});
