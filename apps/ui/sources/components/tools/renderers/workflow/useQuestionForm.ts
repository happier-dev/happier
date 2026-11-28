import * as React from 'react';

import { homeAccountCredentialScope, subscribeHomeCredentialMutations } from '@/auth/storage/tokenStorage';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

type QuestionFormState = Readonly<{
    selections: ReadonlyMap<number, ReadonlySet<number>>;
    freeformAnswers: ReadonlyMap<number, string>;
    notes: ReadonlyMap<number, string>;
    busy: boolean;
    outcome: 'answered' | 'dismissed' | null;
}>;

const emptyForm: QuestionFormState = {
    selections: new Map(), freeformAnswers: new Map(), notes: new Map(), busy: false, outcome: null,
};

function createQuestionForm() {
    let state = emptyForm;
    let editor: object | undefined;
    const copies = new Set<object>();
    const listeners = new Set<() => void>();
    const notify = () => { for (const listener of listeners) listener(); };
    return {
        getState: () => state,
        getEditor: () => editor,
        isHeld: () => state.busy || (!state.outcome && (state.selections.size + state.freeformAnswers.size + state.notes.size > 0)),
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        present(copy: object, onEmpty: () => void) {
            copies.add(copy);
            editor = copy;
            notify();
            return () => {
                copies.delete(copy);
                if (editor === copy) editor = [...copies].at(-1);
                if (copies.size === 0) onEmpty();
                notify();
            };
        },
        update(produce: (current: QuestionFormState) => QuestionFormState) {
            const next = produce(state);
            if (next === state) return;
            state = next;
            notify();
        },
        clear() {
            state = emptyForm;
            editor = undefined;
            copies.clear();
            notify();
        },
    };
}

type Form = ReturnType<typeof createQuestionForm>;
const questionScopes = new Map<string, { serverId: string; forms: Map<string, Form> }>();

const subscribeEmpty = () => () => {};
const getEmptyForm = () => emptyForm;

subscribeHomeCredentialMutations(event => {
    if (event.kind === 'credentials_set') {
        const before = homeAccountCredentialScope(event.serverId, event.previousCredentials?.token);
        const after = homeAccountCredentialScope(event.serverId, event.credentials?.token);
        if (before && before.accountId === after?.accountId) return;
    }
    for (const [key, entry] of questionScopes) {
        if (entry.serverId !== event.serverId) continue;
        for (const form of entry.forms.values()) form.clear();
        questionScopes.delete(key);
    }
});

type QuestionFormRequest = Readonly<{ id: string; turnId?: string; createdAt: number | null }>;

export const PresentedQuestionRequest = React.createContext<QuestionFormRequest | null>(null);

export function matchesQuestionFormRequest(current: QuestionFormRequest, expected: QuestionFormRequest): boolean {
    return current.id === expected.id && current.turnId === expected.turnId && current.createdAt === expected.createdAt;
}

/** Device-local held text for the exact account, Session and outstanding question occurrence. */
export function useQuestionForm(scope: ServerAccountScope | null, sessionId: string | undefined, request: QuestionFormRequest | undefined, eligible: boolean) {
    const family = scope && sessionId && request ? serverAccountScopedResourceKey(scope, sessionId, request.id) : null;
    const key = request ? JSON.stringify([request.turnId, request.createdAt]) : null;
    const [localForm] = React.useState(createQuestionForm);
    const [copy] = React.useState(() => ({}));
    const [sharedForm, setSharedForm] = React.useState<{ family: string; key: string; form: Form; previous?: Form }>();
    const presented = useLayoutPresentationActive();
    const serverId = scope?.serverId;
    React.useLayoutEffect(() => {
        if (!family || !key || !serverId || !eligible || !presented) return;
        const questionScope = questionScopes.get(family) ?? { serverId, forms: new Map<string, Form>() };
        questionScopes.set(family, questionScope);
        const form = questionScope.forms.get(key) ?? createQuestionForm();
        let previous: Form | undefined;
        for (const older of questionScope.forms.values()) {
            if (older === form) break;
            if (older.isHeld()) previous = older;
        }
        questionScope.forms.set(key, form);
        setSharedForm({ family, key, form, previous });
        return form.present(copy, () => {
            if (!form.isHeld()) questionScope.forms.delete(key);
            if (questionScope.forms.size === 0 && questionScopes.get(family) === questionScope) questionScopes.delete(family);
        });
    }, [copy, eligible, family, key, presented, serverId]);

    const currentShared = sharedForm?.family === family && sharedForm?.key === key ? sharedForm : undefined;
    const form = currentShared?.form ?? localForm;
    const previous = currentShared?.previous;
    const state = React.useSyncExternalStore(form.subscribe, form.getState, form.getState);
    const editor = React.useSyncExternalStore(form.subscribe, form.getEditor, form.getEditor);
    const previousDraft = React.useSyncExternalStore(previous?.subscribe ?? subscribeEmpty, previous?.getState ?? getEmptyForm, getEmptyForm);
    return {
        state,
        previousDraft,
        update: form.update,
        canEdit: presented && (!family || editor === copy),
        isEditor: () => {
            const current = form.getState();
            return presented && !current.busy && !current.outcome && (!family || form.getEditor() === copy);
        },
    };
}
