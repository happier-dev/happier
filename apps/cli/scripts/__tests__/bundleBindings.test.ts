import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findUnboundBundleReferences, findUnboundChunkReferences } from '../bundleBindings.mjs';

// Shape of the qa-runtime `placement-*.mjs` chunk emitted by rollup 4.57.1 (rollup#6540):
// the namespace of a module that re-exports an external binding lists it without importing it.
const unboundNamespaceChunk = `import { requiresAuthenticatedMachineAdmissionForSessionInput } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
function resolveSessionInputTargetMachineId(input) { return requiresAuthenticatedMachineAdmissionForSessionInput(input); }
var sessionInputAdmissionIdentity = /*#__PURE__*/Object.freeze({
  __proto__: null,
  deriveWorkflowSessionInputLocalIdV2: deriveWorkflowSessionInputLocalIdV2,
  resolveSessionInputTargetMachineId: resolveSessionInputTargetMachineId,
  get liveBinding () { return liveBinding; }
});
export { sessionInputAdmissionIdentity as s, missingLocal as m };
`;

describe('bundle bindings', () => {
    it('reports namespace members and local exports that have no binding in their chunk', () => {
        expect(findUnboundChunkReferences(unboundNamespaceChunk)).toEqual([
            'deriveWorkflowSessionInputLocalIdV2', 'liveBinding', 'missingLocal',
        ]);
    });

    it('accepts the same chunk once every reference is imported or declared', () => {
        const bound = `import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
let liveBinding = 1; const { missingLocal } = { missingLocal: 2 };
${unboundNamespaceChunk}`;
        expect(findUnboundChunkReferences(bound)).toEqual([]);
    });

    it('lists every unbound reference across an output directory', () => {
        const root = mkdtempSync(join(tmpdir(), 'happier-bundle-bindings-'));
        try {
            mkdirSync(join(root, 'nested'));
            writeFileSync(join(root, 'nested', 'placement-x.mjs'), unboundNamespaceChunk);
            writeFileSync(join(root, 'index.mjs'), 'export const ok = 1;\n');
            expect(findUnboundBundleReferences(root)).toEqual([
                { file: 'nested/placement-x.mjs', name: 'deriveWorkflowSessionInputLocalIdV2' },
                { file: 'nested/placement-x.mjs', name: 'liveBinding' },
                { file: 'nested/placement-x.mjs', name: 'missingLocal' },
            ]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
