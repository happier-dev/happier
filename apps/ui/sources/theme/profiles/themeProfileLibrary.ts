import { mergeThemeProfileDocumentEdit, type ThemeProfileDocument, type ThemeLibraryEntry, type ThemeProfileLibrary, type ThemeLibraryMutationResult, type ThemeProfileMode, type ThemeProfileSource, type ThemeReference, type ThemeUndoContext, type ThemeUndoHandle } from '@happier-dev/protocol/account/settings/themeProfiles';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ArtifactCreateIdV1Schema } from '@happier-dev/protocol/artifacts/artifactIdV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { getBuiltInThemeLibraryEntries, getBuiltInThemeProfileDocument } from './builtInThemeProfiles';
import { projectThemeLibraryEntries, projectThemeLibraryEntry, projectThemeProfileDocumentPresentation } from './themeProfilePresentation';

export type ThemeProfileArtifactRecord = Readonly<{ document: ThemeProfileDocument; revision: number; headerVersion: number }>;
export type ThemeProfileArtifactSummary = Readonly<{ entry: ThemeLibraryEntry; revision: number; headerVersion: number }>;
/** Persistence boundary: Artifact supplies CAS, encryption and publication. */
export interface ThemeProfileArtifactAdapter {
    load(): Promise<void>;
    list(): readonly ThemeProfileArtifactSummary[];
    get(id: string): Promise<ThemeProfileArtifactRecord | null>;
    getSummary(id: string): Promise<ThemeProfileArtifactSummary | null>;
    save(document: ThemeProfileDocument, expectedRevision?: number): Promise<Readonly<{ id: string; revision: number; headerVersion: number; document: ThemeProfileDocument; created?: boolean }>>;
    delete(id: string, expectedRevision?: number): Promise<void>;
}
/** One current operation on this client, retained by the captured Account's Sync owner. */
export type ThemeProfileUndoState = { current: Readonly<{ handle: ThemeUndoHandle; context: ThemeUndoContext }> | null };
export type ThemeProfileLibraryContext = Readonly<{
    artifacts: ThemeProfileArtifactAdapter;
    readSelection(): Readonly<Record<ThemeProfileMode, ThemeReference | null>>;
    writeSelection(mode: ThemeProfileMode, reference: ThemeReference | null): void | Promise<void>;
    createId(): string;
    now(): number;
    undoState?: ThemeProfileUndoState;
    pluginProfiles?: Readonly<{ list(): readonly ThemeLibraryEntry[]; get(reference: Extract<ThemeReference, { kind: 'plugin' }>): Promise<ThemeProfileDocument | null> }>;
}>;
const unchanged = (entry: ThemeLibraryEntry | null = null): ThemeLibraryMutationResult => ({ entry, change: { changedIds: [], removedIds: [], selectionChangedModes: [] } });
function assertYours(source: ThemeProfileSource): void {
    if (source.kind !== 'yours') throw new Error('Duplicate this theme before editing');
}
function sameContent(left: ThemeProfileDocument, right: ThemeProfileDocument): boolean {
    const { updatedAt: _left, ...before } = left.raw;
    const { updatedAt: _right, ...after } = right.raw;
    return sameStrictJsonValue(before, after);
}
function assertAcknowledgedContent(requested: ThemeProfileDocument, acknowledged: ThemeProfileDocument): void {
    if (!sameContent(acknowledged, requested)) {
        throw createActionExecuteFailureError({ ok: false, errorCode: 'conflict', error: 'Theme already exists; open it before editing' });
    }
}

export function createThemeProfileLibrary(context: ThemeProfileLibraryContext): ThemeProfileLibrary {
    const { artifacts } = context;
    const undoState = context.undoState ?? { current: null };
    const find = (reference: ThemeReference): ThemeLibraryEntry | null => reference.kind === 'artifact'
        ? artifacts.list().find(row => row.entry.id === reference.id)?.entry ?? null
        : reference.kind === 'built-in' ? getBuiltInThemeLibraryEntries().find(entry => entry.source.kind === 'built-in' && entry.source.presetId === reference.presetId) ?? null
            : context.pluginProfiles?.list().find(entry => sameStrictJsonValue(entry.reference, reference)) ?? null;
    const recordUndo = (undo: ThemeUndoContext): ThemeUndoHandle => {
        const handle = context.createId();
        undoState.current = { handle, context: undo };
        return handle;
    };
    const save = async (document: ThemeProfileDocument, operation: 'save' | 'keep' = 'save') => {
        assertYours(document.profile.source ?? { kind: 'yours' });
        const reference: ThemeReference = { kind: 'artifact', id: document.profile.id };
        const summary = find(reference);
        if (summary) assertYours(summary.source);
        const current = summary ? await artifacts.get(document.profile.id) : null;
        if (summary && !current) throw createActionExecuteFailureError({ ok: false, errorCode: 'theme_not_found', error: 'Theme not found' });
        if (current && sameContent(current.document, document)) return { result: unchanged(summary), createdRecord: undefined };
        if (current && operation === 'keep') throw new Error('Save deliberate edits before applying this theme');
        const id = current || ArtifactCreateIdV1Schema.safeParse(document.profile.id).success ? document.profile.id : context.createId();
        const next = mergeThemeProfileDocumentEdit(document, { id, ...(current ? { updatedAt: new Date(context.now()).toISOString() } : {}) });
        const written = await artifacts.save(next, current?.revision);
        if (!current && operation === 'keep' && written.created === undefined) {
            throw createActionExecuteFailureError({ ok: false, errorCode: 'artifact_content_unavailable', error: 'This server did not acknowledge whether the theme was created; open the saved theme before applying it' });
        }
        if (!current) assertAcknowledgedContent(next, written.document);
        const entry = projectThemeLibraryEntry(written.document);
        const result: ThemeLibraryMutationResult = !current && written.created === false ? unchanged(entry)
            : { entry, change: { changedIds: [written.id], removedIds: [], selectionChangedModes: [] } };
        return { result, createdRecord: !current && written.created === true ? { id: written.id, revision: written.revision } : undefined };
    };
    const library: ThemeProfileLibrary = {
        list: async () => {
            await artifacts.load();
            const saved = artifacts.list().map(row => row.entry);
            return projectThemeLibraryEntries(saved, context.pluginProfiles?.list() ?? [], getBuiltInThemeLibraryEntries());
        },
        get: async reference => {
            if (reference.kind === 'built-in') return getBuiltInThemeProfileDocument(reference.presetId);
            if (reference.kind === 'plugin') {
                const document = await context.pluginProfiles?.get(reference);
                return document ? projectThemeProfileDocumentPresentation(document) : null;
            }
            return (await artifacts.get(reference.id))?.document ?? null;
        },
        save: async ({ document }) => (await save(document)).result,
        keep: async ({ document, mode }) => {
            const previousSelection = context.readSelection()[mode];
            const saved = await save(document, 'keep');
            const reference: ThemeReference = { kind: 'artifact', id: saved.result.entry!.id };
            const changed = !sameStrictJsonValue(previousSelection, reference);
            if (changed) await context.writeSelection(mode, reference);
            const undo = recordUndo({ mode, previousSelection, appliedSelection: reference, ...(saved.createdRecord ? { createdRecord: saved.createdRecord } : {}) });
            return { ...saved.result, change: { ...saved.result.change, selectionChangedModes: changed ? [mode] : [] }, undo };
        },
        delete: async (id, options) => {
            const summary = await artifacts.getSummary(id);
            const entry = summary?.entry;
            if (!entry || !summary) return unchanged();
            if (!entry.deletable || entry.source.kind !== 'yours') throw new Error('Theme is owned by its source');
            await artifacts.delete(id, options?.expectedRevision ?? summary.revision);
            // Missing references render the mode's base; deletion never rewrites a preference.
            return { entry: null, change: { changedIds: [], removedIds: [id], selectionChangedModes: [] } };
        },
        duplicate: async ({ reference, name }) => {
            const document = await library.get(reference);
            if (!document) throw createActionExecuteFailureError({ ok: false, errorCode: 'theme_not_found', error: 'Theme not found' });
            const timestamp = new Date(context.now()).toISOString();
            const copy = mergeThemeProfileDocumentEdit(document, { id: context.createId(), name: name ?? document.profile.name,
                createdAt: timestamp, updatedAt: timestamp, source: { kind: 'yours' } });
            return library.save({ document: copy });
        },
        select: async ({ mode, reference }) => {
            let entry = reference ? find(reference) : null;
            if (!entry && reference?.kind === 'artifact') {
                const record = await artifacts.get(reference.id);
                if (record) entry = projectThemeLibraryEntry(record.document);
            }
            if (reference && !entry) throw createActionExecuteFailureError({ ok: false, errorCode: 'theme_not_found', error: 'Theme not found' });
            const previousSelection = context.readSelection()[mode];
            const changed = !sameStrictJsonValue(previousSelection, reference);
            if (changed) await context.writeSelection(mode, reference);
            return { entry, change: { changedIds: [], removedIds: [], selectionChangedModes: changed ? [mode] : [] },
                undo: recordUndo({ mode, previousSelection, appliedSelection: reference }) };
        },
        lastUndo: () => undoState.current?.handle ?? null,
        undo: async handle => {
            const operation = undoState.current;
            if (!operation || operation.handle !== handle) throw createActionExecuteFailureError({ ok: false, errorCode: 'theme_undo_handle_unknown', error: 'Theme Undo is no longer available' });
            const undo = operation.context;
            let result = unchanged();
            if (undo.createdRecord) {
                await artifacts.delete(undo.createdRecord.id, undo.createdRecord.revision);
                result = { entry: null, change: { changedIds: [], removedIds: [undo.createdRecord.id], selectionChangedModes: [] } };
            }
            if (!sameStrictJsonValue(undo.previousSelection, undo.appliedSelection)
                && sameStrictJsonValue(context.readSelection()[undo.mode], undo.appliedSelection)) {
                await context.writeSelection(undo.mode, undo.previousSelection);
                result = { ...result, entry: undo.previousSelection ? find(undo.previousSelection) : null, change: { ...result.change, selectionChangedModes: [undo.mode] } };
            }
            if (undoState.current === operation) undoState.current = null;
            return result;
        },
    };
    return library;
}

export interface ThemeProfileSourceAdapter {
    list(): Promise<readonly ThemeLibraryEntry[]>;
    save(document: ThemeProfileDocument): Promise<ThemeLibraryMutationResult>;
    delete(id: string): Promise<ThemeLibraryMutationResult>;
}

/** Store's admitted provenance uses these records without granting user save source authority. */
export function createThemeProfileSourceAdapter(context: ThemeProfileLibraryContext): ThemeProfileSourceAdapter {
    const keyOf = (source: Extract<ThemeProfileSource, { kind: 'store' }>) =>
        JSON.stringify([source.provenance.sourceId, source.provenance.itemId, source.contributionId]);
    // The captured source adapter lives for one admitted operation (including its faces).
    // Successful writes update this index so retries in that operation see acknowledged records.
    let sourceIndex: Map<string, ThemeProfileArtifactSummary> | undefined;
    const index = () => sourceIndex ??= new Map(context.artifacts.list().flatMap(summary =>
        summary.entry.source.kind === 'store' ? [[keyOf(summary.entry.source), summary] as const] : []));
    return {
        list: async () => {
            await context.artifacts.load();
            return context.artifacts.list().flatMap(({ entry }) => entry.source.kind === 'store' ? [entry] : []);
        },
        async save(document: ThemeProfileDocument): Promise<ThemeLibraryMutationResult> {
            const source = document.profile.source;
            if (source?.kind !== 'store') throw new Error('Expected admitted Store theme');
            await context.artifacts.load();
            const currentSummary = index().get(keyOf(source));
            const current = currentSummary ? await context.artifacts.get(currentSummary.entry.id) : null;
            if (currentSummary && !current) throw createActionExecuteFailureError({ ok: false, errorCode: 'theme_not_found', error: 'Theme not found' });
            let next = mergeThemeProfileDocumentEdit(document, { id: current?.document.profile.id ?? context.createId(),
                ...(current ? { createdAt: current.document.profile.createdAt } : {}) });
            if (current) {
                const previousSource = current.document.profile.source;
                const comparable = previousSource?.kind === 'store' ? mergeThemeProfileDocumentEdit(next, {
                    source: { ...source, provenance: { ...source.provenance, importedAt: previousSource.provenance.importedAt } },
                }) : next;
                if (sameContent(current.document, comparable)) return unchanged(currentSummary!.entry);
                next = mergeThemeProfileDocumentEdit(next, { updatedAt: new Date(context.now()).toISOString() });
            }
            const result = await context.artifacts.save(next, current?.revision);
            if (!current) assertAcknowledgedContent(next, result.document);
            const entry = projectThemeLibraryEntry(result.document);
            index().set(keyOf(source), { entry, revision: result.revision, headerVersion: result.headerVersion });
            return !current && result.created === false ? unchanged(entry)
                : { entry, change: { changedIds: [result.id], removedIds: [], selectionChangedModes: [] } };
        },
        async delete(id: string): Promise<ThemeLibraryMutationResult> {
            await context.artifacts.load();
            const summary = context.artifacts.list().find(row => row.entry.id === id);
            if (!summary) return unchanged();
            if (summary.entry.source.kind !== 'store') throw new Error('Expected installed Store theme');
            await context.artifacts.delete(id, summary.revision);
            sourceIndex?.delete(keyOf(summary.entry.source));
            return { entry: null, change: { changedIds: [], removedIds: [id], selectionChangedModes: [] } };
        },
    };
}
