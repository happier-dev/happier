import { describe, expect, it } from 'vitest';
import { connectedMetadataSourceNeedsCleanupV1, loadConnectedMetadataCatalogV1, type ConnectedMetadataLoadInputV1 } from './connectedMetadataCatalogV1.js';
import type { ConnectedPresentationRowReadResponseV1Schema } from './connectedAccountPresentationRowsV1.js';

const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const subject = { kind: 'account' as const, account: { service, accountId: 'default' } };
const existing = { status: 'present' as const, revision: 4, content: { t: 'plain' as const, v: { v: 1 as const, entries: [{ v: 1 as const, subject, label: 'Newer' }] } } };
function input(): ConnectedMetadataLoadInputV1 {
    return { mode: 'plain', material: null, readPresentationRow: async () => existing,
        readAcknowledgementsRow: async () => ({ status: 'deleted', revision: 8 }) };
}

describe('connected metadata catalog destination authority', () => {
    it('skips the finished source pass for published rows only when the admitted raw Settings proves no retained root', async () => {
        const counts = { sourceReads: 0, historyPasses: 0, initialized: 0 };
        let raw: Record<string, unknown> = { connectedServicesProfileLabelByKey: { 'openai-codex/default': 'Retained 0.2 label' } };
        let presentation: 'absent' | 'present' = 'present';
        const load = (rawSettings: () => Record<string, unknown> | undefined) => loadConnectedMetadataCatalogV1({ ...input(),
            readPresentationRow: async () => presentation === 'absent' ? { status: 'absent' } : existing,
            transfer: {
                needsSourceCleanup: () => connectedMetadataSourceNeedsCleanupV1({ rawSettings: rawSettings(), cleanupPending: false }),
                readSourceSnapshot: async () => { counts.sourceReads++; return { raw, version: 12 }; },
                readInventory: async () => ({ entities: [subject], agents: [] }),
                initializePresentation: async () => { counts.initialized++; presentation = 'present'; return { status: 'updated', revision: 4, cursor: 1 }; },
                initializeAcknowledgements: async () => { throw new Error('Deleted authority must not be reseeded'); },
                replaceSource: async value => { raw = { ...value.raw }; return { status: 'applied', settingsVersion: 13 }; },
                normalizeHistory: async () => { counts.historyPasses++; return { status: 'complete' }; },
            } });
        // Upgraded 0.2 data: the retained root is still in the admitted document.
        expect((await load(() => raw)).cleanup).toEqual({ status: 'complete' });
        expect(raw).toEqual({});
        expect(counts).toEqual({ sourceReads: 1, historyPasses: 1, initialized: 0 });
        // Already migrated: no source read or history pass.
        expect((await load(() => raw)).presentation).toMatchObject({ status: 'ready', revision: 4 });
        expect(counts).toEqual({ sourceReads: 1, historyPasses: 1, initialized: 0 });
        // An unknown document fails toward the source pass.
        await load(() => undefined);
        expect(counts.sourceReads).toBe(2);
        // An absent row still initializes from the source whatever the document says.
        presentation = 'absent';
        await load(() => raw);
        expect(counts).toMatchObject({ sourceReads: 3, initialized: 1 });
    });
    it('does not enumerate transfer inventory when the current Settings source has no connected metadata roots', async () => {
        let inventoryReads = 0;
        let raw: Record<string, unknown> = { unrelatedPreference: true };
        const load = () => loadConnectedMetadataCatalogV1({ ...input(), transfer: {
            readSourceSnapshot: async () => ({ raw, version: 12 }),
            readInventory: async () => { inventoryReads++; return { entities: [subject], agents: [] }; },
            initializePresentation: async () => { throw new Error('Present authority must not be reseeded'); },
            initializeAcknowledgements: async () => { throw new Error('Deleted authority must not be reseeded'); },
            replaceSource: async value => { raw = { ...value.raw }; return { status: 'applied', settingsVersion: 13 }; },
            normalizeHistory: async () => ({ status: 'complete' }),
        } });
        const initial = await load();
        expect(initial.presentation).toMatchObject({ status: 'ready', revision: 4 });
        expect(inventoryReads).toBe(0);
        raw = { ...raw, connectedServicesProfileLabelByKey: { 'openai-codex/default': 'Retained legacy label' } };
        const maintained = await load();
        expect(inventoryReads).toBe(1);
        expect(maintained.presentation).toEqual(initial.presentation);
        expect(raw).toEqual({ unrelatedPreference: true });
        await load();
        expect(inventoryReads).toBe(1);
    });

    it('preserves sensitive row denial separately from transient transport failure and independent acknowledgement authority', async () => {
        for (const code of ['unauthorized', 'forbidden'] as const) {
            const catalog = await loadConnectedMetadataCatalogV1({ ...input(), readPresentationRow: async () => { throw { code }; } });
            expect(catalog.presentation).toEqual({ status: 'unavailable', reason: code });
            expect(catalog.acknowledgements).toEqual({ status: 'ready', entries: [], revision: 8, diagnostics: [] });
        }
        const transient = await loadConnectedMetadataCatalogV1({ ...input(), readPresentationRow: async () => { throw new Error('offline'); } });
        expect(transient.presentation).toEqual({ status: 'unavailable', reason: 'unreachable' });
    });

    it('retains present and deleted authority before optional source maintenance', async () => {
        const seen: string[] = [];
        const catalog = await loadConnectedMetadataCatalogV1({ ...input(),
            onReadyBeforeCleanup: async () => { seen.push('published'); },
            transfer: {
                readSourceSnapshot: async () => { seen.push('source'); throw new Error('offline'); },
                readInventory: async () => ({ entities: [subject], agents: [] }),
                initializePresentation: async () => { throw new Error('must not reseed'); },
                initializeAcknowledgements: async () => { throw new Error('must not reseed'); },
            } });
        expect(catalog.presentation).toEqual({ status: 'ready', entries: existing.content.v.entries, revision: 4, diagnostics: [] });
        expect(catalog.acknowledgements).toEqual({ status: 'ready', entries: [], revision: 8, diagnostics: [] });
        expect(seen).toEqual(['published', 'source']);
        expect(catalog.cleanup).toMatchObject({ status: 'cleanup-pending' });
    });

    it('keeps source when missing acknowledgement initialization loses Settings CAS', async () => {
        let sourceRemoved = false;
        let request: unknown;
        const catalog = await loadConnectedMetadataCatalogV1({ ...input(), readAcknowledgementsRow: async () => ({ status: 'absent' }),
            transfer: {
                readSourceSnapshot: async () => ({ version: 12, raw: { unknown: { preserve: true }, dismissedCLIWarnings: { global: { installation: false }, perMachine: {} } } }),
                readInventory: async () => ({ entities: [subject], agents: [] }),
                initializePresentation: async () => { throw new Error('existing presentation is authoritative'); },
                initializeAcknowledgements: async value => { request = value; return { status: 'settings-conflict', revision: 13 }; },
                replaceSource: async () => { sourceRemoved = true; return { status: 'applied', settingsVersion: 13 }; },
                normalizeHistory: async () => ({ status: 'complete' }),
            } });
        expect(request).toEqual({ record: { v: 1, entries: [{ v: 1, subject: { kind: 'warning', warningId: 'installation', scope: { kind: 'account' } }, acknowledged: false }] }, expectedRevision: 'absent', sourceSettingsVersion: 12 });
        expect(catalog.presentation.status).toBe('ready');
        expect(catalog.acknowledgements).toMatchObject({ status: 'partial', revision: 'absent', diagnostics: [{ reason: 'source-version-conflict' }] });
        expect(sourceRemoved).toBe(false);
    });

    it('activates complete labels independently and retires only admitted roots while preserving malformed acknowledgement and unrelated source data', async () => {
        let row: ReturnType<typeof ConnectedPresentationRowReadResponseV1Schema.parse> = { status: 'absent' };
        let source: Readonly<Record<string, unknown>> = { connectedServicesProfileLabelByKey: { 'openai-codex/default': 'Work' },
            connectedServicesDefaultAuthPoolAdoptionDismissedByKey: { unknown: true },
            unknown: { preserve: true } };
        let retiredRoots: readonly string[] = [];
        const catalog = await loadConnectedMetadataCatalogV1({ ...input(), readPresentationRow: async () => row,
            readAcknowledgementsRow: async () => ({ status: 'absent' }), transfer: {
                readSourceSnapshot: async () => ({ raw: source, version: 12 }), readInventory: async () => ({ entities: [subject], agents: [] }),
                initializePresentation: async value => { row = { status: 'present', revision: 0, content: { t: 'plain', v: value.record } }; return { status: 'updated', revision: 0, cursor: 1 }; },
                initializeAcknowledgements: async () => { throw new Error('incomplete adoption may not activate'); },
                replaceSource: async value => { source = value.raw; return { status: 'applied', settingsVersion: 13 }; },
                normalizeHistory: async value => { retiredRoots = value.activeTransferredRoots; return { status: 'complete' }; },
            } });
        expect(catalog.presentation).toMatchObject({ status: 'ready', revision: 0, entries: [{ subject, label: 'Work' }] });
        expect(catalog.acknowledgements).toMatchObject({ status: 'partial', revision: 'absent' });
        expect(source).toEqual({ connectedServicesDefaultAuthPoolAdoptionDismissedByKey: { unknown: true },
            unknown: { preserve: true } });
        expect(retiredRoots).toEqual(['connectedServicesProfileLabelByKey']);
        expect(catalog.cleanup).toMatchObject({ status: 'cleanup-pending' });
    });
});
