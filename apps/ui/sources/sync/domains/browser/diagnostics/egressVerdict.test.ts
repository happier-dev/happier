import {
    classifyBrowserDiagnosticField,
    classifyBrowserDiagnosticFieldForDestination,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

/**
 * DEV-7 closure gate. The PageSpy-parity additive families (sendBeacon, on-demand DOM snapshot,
 * storage key-inventory) are CAPTURED in `injectedPage.ts` and asserted intercept→emit in
 * `injectedPage.test.ts`. This test closes the remaining gate clause: every captured field for those
 * kinds is routed through the LANDED LANE-B egress classifier (`classifyBrowserDiagnosticField`) with
 * the correct keep/drop verdict — proving the additive capture cannot smuggle a non-allowlisted value
 * (e.g. a beacon payload, page markup, or a stored value) past the single egress SSOT.
 */
describe('DEV-7 additive diagnostics families route through the LANE-B egress classifier', () => {
    it('keeps only sanitized sendBeacon metadata (sanitized url + queued byte count + acceptance)', () => {
        expect(classifyBrowserDiagnosticField('network.sendBeacon', 'url')).toBe('keep');
        expect(classifyBrowserDiagnosticField('network.sendBeacon', 'bytesQueued')).toBe('keep');
        expect(classifyBrowserDiagnosticField('network.sendBeacon', 'accepted')).toBe('keep');
        // The beacon PAYLOAD must never be allowlisted.
        expect(classifyBrowserDiagnosticField('network.sendBeacon', 'body')).toBe('drop');
        expect(classifyBrowserDiagnosticField('network.sendBeacon', 'payload')).toBe('drop');
    });

    it('keeps only structural DOM-snapshot counts, never page text or markup', () => {
        expect(classifyBrowserDiagnosticField('pageInfo.domSnapshot', 'nodeCount')).toBe('keep');
        expect(classifyBrowserDiagnosticField('pageInfo.domSnapshot', 'elementCount')).toBe('keep');
        expect(classifyBrowserDiagnosticField('pageInfo.domSnapshot', 'maxDepth')).toBe('keep');
        expect(classifyBrowserDiagnosticField('pageInfo.domSnapshot', 'html')).toBe('drop');
        expect(classifyBrowserDiagnosticField('pageInfo.domSnapshot', 'outerHTML')).toBe('drop');
        expect(classifyBrowserDiagnosticField('pageInfo.domSnapshot', 'textContent')).toBe('drop');
    });

    it('keeps storage key metadata and treats stored entries as owner-only values', () => {
        expect(classifyBrowserDiagnosticField('storage.keyInventory', 'storageType')).toBe('keep');
        expect(classifyBrowserDiagnosticField('storage.keyInventory', 'keyCount')).toBe('keep');
        expect(classifyBrowserDiagnosticField('storage.keyInventory', 'keys')).toBe('keep');
        // Stored values are local-owner only: fail-closed without a destination, kept only for owner.
        expect(classifyBrowserDiagnosticField('storage.keyInventory', 'values')).toBe('drop');
        expect(classifyBrowserDiagnosticField('storage.keyInventory', 'entries')).toBe('drop');
        expect(classifyBrowserDiagnosticFieldForDestination('storage.keyInventory', 'entries', 'localOwner')).toBe('keep');
        expect(classifyBrowserDiagnosticFieldForDestination('storage.keyInventory', 'entries', 'agentContext')).toBe('drop');
    });

    it('always strips credential-egress vectors regardless of the additive kind', () => {
        expect(classifyBrowserDiagnosticField('network.sendBeacon', 'cookie')).toBe('always-strip');
        expect(classifyBrowserDiagnosticField('network.sendBeacon', 'authorization')).toBe('always-strip');
        expect(classifyBrowserDiagnosticField('storage.keyInventory', 'cookie')).toBe('always-strip');
    });

    it('keeps the owner-only console text for the local owner but strips it for agent/remote (DEV-2)', () => {
        // Fail-closed at the destination-agnostic verdict: console text reads as drop with no owner ctx.
        expect(classifyBrowserDiagnosticField('console.entry', 'text')).toBe('drop');
        // The local owner sees the full console text; agent + remote egress strip it.
        expect(classifyBrowserDiagnosticFieldForDestination('console.entry', 'text', 'localOwner')).toBe('keep');
        expect(classifyBrowserDiagnosticFieldForDestination('console.entry', 'text', 'agentContext')).toBe('drop');
        expect(classifyBrowserDiagnosticFieldForDestination('console.entry', 'text', 'remoteSnapshot')).toBe('drop');
        // Plain metadata stays keep everywhere; credential vectors stay stripped even for the owner.
        expect(classifyBrowserDiagnosticFieldForDestination('console.entry', 'level', 'agentContext')).toBe('keep');
        expect(classifyBrowserDiagnosticFieldForDestination('console.entry', 'authorization', 'localOwner')).toBe('always-strip');
    });
});
