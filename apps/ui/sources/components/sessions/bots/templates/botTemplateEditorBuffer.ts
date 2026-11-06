import type { BotTemplateDraftV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { McpServerCatalogEntryTransportV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

export type BotTemplateRevision = Readonly<{ headerVersion: number; bodyVersion: number }>;
/** Unconfirmed authoring inputs travel with the pane/page buffer, never the saved template. */
export type BotTemplateNeedAuthoring = Readonly<{
    open: boolean;
    kind: keyof BotTemplateDraftV1['content']['needs'];
    name: string;
    purpose: string;
    skipConsequence: string;
    selection: string | null;
    transport: McpServerCatalogEntryTransportV1;
    endpoint: string;
    args: string;
    envNames: string;
    headerNames: string;
}>;
const emptyNeedAuthoring: BotTemplateNeedAuthoring = { open: false, kind: 'software', name: '', purpose: '',
    skipConsequence: '', selection: null, transport: 'stdio', endpoint: '', args: '', envNames: '', headerNames: '' };
export type BotTemplateEditorSnapshot = Readonly<{
    draft: BotTemplateDraftV1;
    revision: BotTemplateRevision;
    status: 'saved' | 'unsaved' | 'saving' | 'failed' | 'conflict';
    errorCode?: string;
    releaseOptions: Readonly<{ version: string; changelog: string }>;
    needAuthoring: BotTemplateNeedAuthoring;
}>;
export type BotTemplateSave = (input: Readonly<{ draft: BotTemplateDraftV1; revision: BotTemplateRevision }>) => Promise<
    Readonly<{ ok: true; revision: BotTemplateRevision }> | Readonly<{ ok: false; code: string }>>;

export function createBotTemplateEditorBuffer(opening: Pick<BotTemplateEditorSnapshot, 'draft' | 'revision'>) {
    let snapshot: BotTemplateEditorSnapshot = { ...opening, status: 'saved', releaseOptions: { version: '1.0.0', changelog: '' }, needAuthoring: emptyNeedAuthoring };
    let savedDraft = opening.draft;
    let pending: Promise<void> | null = null;
    const listeners = new Set<() => void>();
    const publish = (next: BotTemplateEditorSnapshot) => {
        snapshot = next;
        for (const listener of listeners) listener();
    };
    const edit = (change: (draft: BotTemplateDraftV1) => BotTemplateDraftV1) => {
        const draft = change(snapshot.draft);
        if (draft === snapshot.draft) return;
        publish({ ...snapshot, draft, status: snapshot.status === 'saving' ? 'saving'
            : snapshot.status === 'conflict' ? 'conflict' : 'unsaved' });
    };
    return {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        /** External redrafts replace only clean saved content; dirty text keeps its original CAS. */
        reconcile: (opening: Pick<BotTemplateEditorSnapshot, 'draft' | 'revision'>) => {
            if (snapshot.status !== 'saved' || opening.revision.headerVersion < snapshot.revision.headerVersion
                || opening.revision.bodyVersion < snapshot.revision.bodyVersion
                || (opening.revision.headerVersion === snapshot.revision.headerVersion
                    && opening.revision.bodyVersion === snapshot.revision.bodyVersion)) return;
            savedDraft = opening.draft;
            publish({ ...snapshot, ...opening, errorCode: undefined });
        },
        editRelease: (releaseOptions: BotTemplateEditorSnapshot['releaseOptions']) => publish({ ...snapshot, releaseOptions }),
        editNeedAuthoring: (change: Partial<BotTemplateNeedAuthoring>) => publish({ ...snapshot, needAuthoring: { ...snapshot.needAuthoring, ...change } }),
        resetNeedAuthoring: () => publish({ ...snapshot, needAuthoring: emptyNeedAuthoring }),
        edit,
        selectMemory: (key: string, selected: boolean) => edit(draft => ({ ...draft, candidates: { ...draft.candidates,
            memoryRules: draft.candidates.memoryRules.map(item => item.key === key && item.selected !== selected ? { ...item, selected } : item) } })),
        selectSkill: (key: string, selection: BotTemplateDraftV1['candidates']['skills'][number]['selection']) => edit(draft => ({ ...draft,
            candidates: { ...draft.candidates, skills: draft.candidates.skills.map(item => item.key === key && item.selection !== selection
                ? { ...item, selection, ...(selection === 'general_copy' && !item.generalCopy
                    ? { generalCopy: { title: item.title, entries: item.entries } } : {}) } : item) } })),
        editSkillFile: (key: string, path: string, text: string) => edit(draft => ({ ...draft, candidates: { ...draft.candidates,
            skills: draft.candidates.skills.map(item => item.key === key && item.selection === 'general_copy' && item.generalCopy
                ? { ...item, generalCopy: { ...item.generalCopy, entries: item.generalCopy.entries.map(file => file.path === path && file.contentKind === 'utf8'
                    ? { ...file, contentBase64: encodeBase64(new TextEncoder().encode(text)) } : file) } } : item) } })),
        /** A person explicitly rebases after inspecting the other revision; local text stays intact. */
        useRevision: (revision: BotTemplateRevision) => publish({ ...snapshot, revision, status: 'unsaved', errorCode: undefined }),
        commit: function commit(save: BotTemplateSave): Promise<void> {
            if (pending) {
                const requestedDraft = snapshot.draft;
                return pending.then(() => {
                    if (requestedDraft !== savedDraft && snapshot.status === 'unsaved') return commit(save);
                });
            }
            if (snapshot.draft === savedDraft || snapshot.status === 'conflict') return Promise.resolve();
            const captured = { draft: snapshot.draft, revision: snapshot.revision };
            publish({ ...snapshot, status: 'saving', errorCode: undefined });
            pending = (async () => {
                try {
                    const result = await save(captured);
                    if (result.ok) {
                        savedDraft = captured.draft;
                        publish({ ...snapshot, draft: snapshot.draft, revision: result.revision,
                            status: snapshot.draft === captured.draft ? 'saved' : 'unsaved' });
                    } else {
                        publish({ ...snapshot, status: result.code === 'version_mismatch' ? 'conflict' : 'failed', errorCode: result.code });
                    }
                } catch {
                    publish({ ...snapshot, status: 'failed', errorCode: 'network_error' });
                } finally { pending = null; }
            })();
            return pending;
        },
    };
}

export type BotTemplateEditorBuffer = ReturnType<typeof createBotTemplateEditorBuffer>;
