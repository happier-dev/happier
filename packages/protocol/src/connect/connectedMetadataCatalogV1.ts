import type { ConnectedMetadataCleanupV1 } from "./connectedAccountPresentationSchemasV1.js";
export { ConnectedMetadataCleanupV1Schema } from "./connectedAccountPresentationSchemasV1.js";
export type { ConnectedMetadataCleanupV1 } from "./connectedAccountPresentationSchemasV1.js";
import * as z from 'zod/mini';
import type { AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import { type ConnectedPresentationRecordV1, type ConnectedAcknowledgementsRecordV1, type ConnectedPresentationCatalogSnapshotV1, type ConnectedAcknowledgementsCatalogSnapshotV1, type ConnectedDisclosureEntryV1, type LegacyConnectedMetadataInventoryV1, type ConnectedPresentationRowReadResponseV1Schema, type ConnectedAcknowledgementsRowReadResponseV1Schema, type ConnectedMetadataRowMutationResponseV1Schema, openConnectedPresentationContentV1, openConnectedAcknowledgementsContentV1, readLegacyConnectedMetadataV1, CONNECTED_PRESENTATION_SOURCE_ROOTS_V1, CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1, CONNECTED_DISCLOSURE_SOURCE_ROOT_V1, type ConnectedMetadataDiagnosticV1 } from './connectedAccountPresentationRowsV1.js';

export type ConnectedMetadataCatalogV1 = Readonly<{
    presentation: ConnectedPresentationCatalogSnapshotV1; acknowledgements: ConnectedAcknowledgementsCatalogSnapshotV1;
    disclosure: readonly ConnectedDisclosureEntryV1[]; cleanup?: ConnectedMetadataCleanupV1;
}>;
export type ConnectedMetadataSourceTransferV1 = Readonly<{
    readSourceSnapshot(): Promise<Readonly<{ raw: Readonly<Record<string, unknown>>; version: number }>>;
    readInventory(): Promise<LegacyConnectedMetadataInventoryV1>;
    initializePresentation(input: Readonly<{ record: ConnectedPresentationRecordV1; expectedRevision: 'absent'; sourceSettingsVersion: number }>): Promise<z.infer<typeof ConnectedMetadataRowMutationResponseV1Schema>>;
    initializeAcknowledgements(input: Readonly<{ record: ConnectedAcknowledgementsRecordV1; expectedRevision: 'absent'; sourceSettingsVersion: number }>): Promise<z.infer<typeof ConnectedMetadataRowMutationResponseV1Schema>>;
    replaceSource?(input: Readonly<{ raw: Readonly<Record<string, unknown>>; expectedVersion: number }>): Promise<
        Readonly<{ status: 'applied'; settingsVersion: number }> | Readonly<{ status: 'conflict'; currentSettingsVersion: number }>
        | Readonly<{ status: 'outcomeUnknown'; lastKnownSettingsVersion: number }> | Readonly<{ status: 'rejected' }>>;
    normalizeHistory?(input: Readonly<{ activeTransferredRoots: readonly string[] }>): Promise<Readonly<{ status: 'complete' }> | Readonly<{ status: 'cleanup-pending'; versions: readonly number[] }>>;
    persistDisclosure?(entries: readonly ConnectedDisclosureEntryV1[]): Promise<void>;
}>;
export type ConnectedMetadataLoadInputV1 = Readonly<{
    mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; signal?: AbortSignal;
    readPresentationRow(): Promise<z.infer<typeof ConnectedPresentationRowReadResponseV1Schema>>;
    readAcknowledgementsRow(): Promise<z.infer<typeof ConnectedAcknowledgementsRowReadResponseV1Schema>>;
    transfer?: ConnectedMetadataSourceTransferV1;
    onReadyBeforeCleanup?: (catalog: ConnectedMetadataCatalogV1) => Promise<void>;
    hasPendingCleanup?: () => boolean;
}>;
type PresentationRead = z.infer<typeof ConnectedPresentationRowReadResponseV1Schema>;
type AcknowledgementsRead = z.infer<typeof ConnectedAcknowledgementsRowReadResponseV1Schema>;
type RowTransportFailure = Readonly<{ status: 'transport-unavailable'; reason: string }>;
function transportFailureReason(error: unknown): string {
    return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code.length > 0
        ? error.code : 'unreachable';
}
async function readRows(input: ConnectedMetadataLoadInputV1) {
    const [presentation, acknowledgements] = await Promise.allSettled([input.readPresentationRow(), input.readAcknowledgementsRow()]);
    return { presentation: presentation.status === 'fulfilled' ? presentation.value : { status: 'transport-unavailable' as const, reason: transportFailureReason(presentation.reason) },
        acknowledgements: acknowledgements.status === 'fulfilled' ? acknowledgements.value : { status: 'transport-unavailable' as const, reason: transportFailureReason(acknowledgements.reason) } };
}
function presentationSnapshot(input: ConnectedMetadataLoadInputV1, row: PresentationRead | RowTransportFailure): ConnectedPresentationCatalogSnapshotV1 {
    if (row.status === 'transport-unavailable') return { status: 'unavailable', reason: row.reason };
    if (row.status === 'absent') return { status: 'unavailable', reason: 'authority-not-confirmed' };
    if (row.status === 'deleted') return { status: 'ready', entries: [], revision: row.revision, diagnostics: [] };
    if (row.status !== 'present') return { status: 'unavailable', reason: row.status };
    const opened = openConnectedPresentationContentV1({ ...input, content: row.content });
    if (opened.status === 'unavailable') return opened;
    if (opened.status === 'partial') return { status: 'partial', entries: opened.record.entries, revision: row.revision, diagnostics: opened.diagnostics };
    return { status: 'ready', entries: opened.record.entries, revision: row.revision, diagnostics: [] };
}
function acknowledgementSnapshot(input: ConnectedMetadataLoadInputV1, row: AcknowledgementsRead | RowTransportFailure): ConnectedAcknowledgementsCatalogSnapshotV1 {
    if (row.status === 'transport-unavailable') return { status: 'unavailable', reason: row.reason };
    if (row.status === 'absent') return { status: 'unavailable', reason: 'authority-not-confirmed' };
    if (row.status === 'deleted') return { status: 'ready', entries: [], revision: row.revision, diagnostics: [] };
    if (row.status !== 'present') return { status: 'unavailable', reason: row.status };
    const opened = openConnectedAcknowledgementsContentV1({ ...input, content: row.content });
    if (opened.status === 'unavailable') return opened;
    if (opened.status === 'partial') return { status: 'partial', entries: opened.record.entries, revision: row.revision, diagnostics: opened.diagnostics };
    return { status: 'ready', entries: opened.record.entries, revision: row.revision, diagnostics: [] };
}
function unavailable(reason: string): ConnectedMetadataCatalogV1 {
    return { presentation: { status: 'unavailable', reason }, acknowledgements: { status: 'unavailable', reason }, disclosure: [] };
}
function diagnosticsForRoots(diagnostics: readonly ConnectedMetadataDiagnosticV1[], roots: readonly string[]) {
    return diagnostics.filter(diagnostic => roots.includes(diagnostic.root) || diagnostic.root === 'inventory' || diagnostic.root === 'accountSettings');
}
/** Present or versioned-deleted rows stay authoritative; each absent catalog initializes in its own CAS. */
export async function loadConnectedMetadataCatalogV1(input: ConnectedMetadataLoadInputV1): Promise<ConnectedMetadataCatalogV1> {
    if (input.signal?.aborted) return unavailable('cancelled');
    if (input.mode === 'plain' && input.material !== null) return unavailable('account-mode-mismatch');
    if (input.mode === 'e2ee' && input.material === null) return unavailable('encryption-material-unavailable');
    let rows = await readRows(input);
    if (input.signal?.aborted) return unavailable('cancelled');
    let catalog: ConnectedMetadataCatalogV1 = { presentation: presentationSnapshot(input, rows.presentation),
        acknowledgements: acknowledgementSnapshot(input, rows.acknowledgements), disclosure: [] };
    if (!input.transfer) return catalog;
    const transfer = input.transfer;
    const missingPresentation = rows.presentation?.status === 'absent';
    const missingAcknowledgements = rows.acknowledgements?.status === 'absent';
    const published = !missingPresentation && !missingAcknowledgements;
    if (published) {
        await input.onReadyBeforeCleanup?.(catalog);
        if (input.hasPendingCleanup?.()) return catalog;
    }
    let source: Awaited<ReturnType<ConnectedMetadataSourceTransferV1['readSourceSnapshot']>>;
    try { source = await transfer.readSourceSnapshot(); }
    catch {
        return { ...catalog,
            ...(missingPresentation ? { presentation: { status: 'partial' as const, entries: [], revision: 'absent' as const, diagnostics: [{ root: CONNECTED_PRESENTATION_SOURCE_ROOTS_V1[0], reason: 'source-unavailable' }] } } : {}),
            ...(missingAcknowledgements ? { acknowledgements: { status: 'partial' as const, entries: [], revision: 'absent' as const, diagnostics: [{ root: CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1[0], reason: 'source-unavailable' }] } } : {}),
            cleanup: { status: 'cleanup-pending', reason: 'source-unavailable' } };
    }
    if (input.signal?.aborted) return unavailable('cancelled');
    let inventory: LegacyConnectedMetadataInventoryV1 = { entities: [], agents: [] };
    let inventoryUnavailable = false;
    try { inventory = await transfer.readInventory(); } catch { inventoryUnavailable = true; }
    if (input.signal?.aborted) return unavailable('cancelled');
    const retained = readLegacyConnectedMetadataV1(source.raw, inventory);
    const presentationDiagnostics = diagnosticsForRoots(retained.diagnostics, CONNECTED_PRESENTATION_SOURCE_ROOTS_V1);
    const acknowledgementDiagnostics = diagnosticsForRoots(retained.diagnostics, CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1);
    if (inventoryUnavailable) {
        if (Object.hasOwn(source.raw, CONNECTED_PRESENTATION_SOURCE_ROOTS_V1[0])) presentationDiagnostics.push({ root: CONNECTED_PRESENTATION_SOURCE_ROOTS_V1[0], reason: 'inventory-unavailable' });
        if (Object.hasOwn(source.raw, CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1[0])) acknowledgementDiagnostics.push({ root: CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1[0], reason: 'inventory-unavailable' });
    }
    let presentationFailure: string | undefined;
    let acknowledgementFailure: string | undefined;
    let attempted = false;
    if (missingPresentation && presentationDiagnostics.length === 0) {
        attempted = true;
        try {
            const receipt = await transfer.initializePresentation({ record: retained.presentation, expectedRevision: 'absent', sourceSettingsVersion: source.version });
            if (receipt.status !== 'updated' && receipt.status !== 'conflict') presentationFailure = receipt.status === 'settings-conflict' ? 'source-version-conflict' : receipt.status;
        } catch { presentationFailure = 'unreachable'; }
    }
    if (input.signal?.aborted) return unavailable('cancelled');
    if (missingAcknowledgements && acknowledgementDiagnostics.length === 0) {
        attempted = true;
        try {
            const receipt = await transfer.initializeAcknowledgements({ record: retained.acknowledgements, expectedRevision: 'absent', sourceSettingsVersion: source.version });
            if (receipt.status !== 'updated' && receipt.status !== 'conflict') acknowledgementFailure = receipt.status === 'settings-conflict' ? 'source-version-conflict' : receipt.status;
        } catch { acknowledgementFailure = 'unreachable'; }
    }
    if (input.signal?.aborted) return unavailable('cancelled');
    if (attempted) {
        rows = await readRows(input);
        if (input.signal?.aborted) return unavailable('cancelled');
        catalog = { presentation: presentationSnapshot(input, rows.presentation), acknowledgements: acknowledgementSnapshot(input, rows.acknowledgements), disclosure: [] };
    }
    if (missingPresentation && rows.presentation?.status === 'absent') catalog = { ...catalog, presentation: { status: 'partial', entries: retained.presentation.entries, revision: 'absent',
        diagnostics: presentationDiagnostics.length ? presentationDiagnostics : [{ root: CONNECTED_PRESENTATION_SOURCE_ROOTS_V1[0], reason: presentationFailure ?? 'authority-not-confirmed' }] } };
    if (missingAcknowledgements && rows.acknowledgements?.status === 'absent') catalog = { ...catalog, acknowledgements: { status: 'partial', entries: retained.acknowledgements.entries, revision: 'absent',
        diagnostics: acknowledgementDiagnostics.length ? acknowledgementDiagnostics : [{ root: CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1[0], reason: acknowledgementFailure ?? 'authority-not-confirmed' }] } };
    catalog = { ...catalog, disclosure: retained.disclosure };
    if (!published) await input.onReadyBeforeCleanup?.(catalog);
    if (input.hasPendingCleanup?.()) return catalog;
    const raw = { ...source.raw };
    const activeRoots: string[] = [];
    let pending: ConnectedMetadataCleanupV1 | undefined;
    for (const [snapshot, roots] of [[catalog.presentation, CONNECTED_PRESENTATION_SOURCE_ROOTS_V1], [catalog.acknowledgements, CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1]] as const) {
        if (snapshot.status !== 'ready') { pending = { status: 'cleanup-pending', reason: 'incomplete-catalog' }; continue; }
        for (const root of roots) {
            if (diagnosticsForRoots(retained.diagnostics, [root]).length || (inventoryUnavailable && root !== CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1[1] && Object.hasOwn(raw, root))) {
                pending = { status: 'cleanup-pending', reason: 'source-unavailable' }; continue;
            }
            delete raw[root]; activeRoots.push(root);
        }
    }
    if (Object.hasOwn(raw, CONNECTED_DISCLOSURE_SOURCE_ROOT_V1)) {
        if (diagnosticsForRoots(retained.diagnostics, [CONNECTED_DISCLOSURE_SOURCE_ROOT_V1]).length || !transfer.persistDisclosure) pending = { status: 'cleanup-pending', reason: 'disclosure-unavailable' };
        else {
            try {
                await transfer.persistDisclosure(retained.disclosure);
                if (input.signal?.aborted) return { ...catalog, cleanup: { status: 'cleanup-pending', reason: 'cancelled' } };
                delete raw[CONNECTED_DISCLOSURE_SOURCE_ROOT_V1];
            } catch { pending = { status: 'cleanup-pending', reason: 'disclosure-unavailable' }; }
        }
    }
    if (input.signal?.aborted) return { ...catalog, cleanup: { status: 'cleanup-pending', reason: 'cancelled' } };
    if (JSON.stringify(raw) !== JSON.stringify(source.raw)) {
        if (!transfer.replaceSource) return { ...catalog, cleanup: { status: 'cleanup-pending', reason: 'source-unavailable' } };
        try {
            const receipt = await transfer.replaceSource({ raw, expectedVersion: source.version });
            if (receipt.status !== 'applied') return { ...catalog, cleanup: { status: 'cleanup-pending', reason: receipt.status === 'conflict' ? 'source-conflict' : 'source-unavailable' } };
        } catch { return { ...catalog, cleanup: { status: 'cleanup-pending', reason: 'source-unavailable' } }; }
    }
    if (activeRoots.length) {
        if (!transfer.normalizeHistory) pending = { status: 'cleanup-pending', reason: 'history-incomplete' };
        else try {
            const history = await transfer.normalizeHistory({ activeTransferredRoots: activeRoots });
            if (history.status !== 'complete') pending = { status: 'cleanup-pending', reason: 'history-incomplete' };
        } catch { pending = { status: 'cleanup-pending', reason: 'history-incomplete' }; }
    }
    return { ...catalog, cleanup: pending ?? { status: 'complete' } };
}
