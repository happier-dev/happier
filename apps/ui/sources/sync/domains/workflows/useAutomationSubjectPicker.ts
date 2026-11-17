import * as React from 'react';
import type { AutomationSubjectKind } from '@happier-dev/plugin-sdk/automations';
import type { DatabaseTargetsListInputV1 } from '@happier-dev/database-protocol';

import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { WorkflowActionCallerContext } from './callWorkflowAction';
import { readAutomationSubjectPickerActionPage, type AutomationSubjectPickerActionPageRequest,
    type AutomationSubjectPickerOption, type AutomationSubjectPickerPage } from './automationSubjectPicker';

type WithoutCursor<T> = T extends Readonly<{ page: infer Page }>
    ? Omit<T, 'page'> & Readonly<{ page: Omit<Page, 'cursor'> }>
    : Omit<T, 'cursor'>;
type ReadableRequest = WithoutCursor<AutomationSubjectPickerActionPageRequest>;
type PickerRequest = ReadableRequest | Readonly<{
    kind: Extract<AutomationSubjectKind, { kind: 'database' }>;
    databaseScope?: DatabaseTargetsListInputV1['scope'];
}>;

export type AutomationSubjectPickerInput = PickerRequest & Readonly<{
    /** Borrow the mount's addressed Account; never substitute the focused Account. */
    lifetime: ServerAccountScopeLifetime | null;
    demanded: boolean;
    /** Keep the mount's Action caller context identity-stable. */
    context?: WorkflowActionCallerContext;
}>;

type PickerState = Readonly<{
    items: readonly AutomationSubjectPickerOption[];
    status: 'idle' | 'loading' | 'loading_more' | 'ready' | 'error' | 'unsupported';
    coverage: AutomationSubjectPickerPage['coverage'];
    nextCursor: string | null;
    error: unknown;
}>;

export type AutomationSubjectPickerRead = Omit<PickerState, 'nextCursor'> & Readonly<{
    hasMore: boolean;
    /** Database list targets do not yet have an owner-published Automation subject projection. */
    unsupported: Readonly<{ owner: 'database'; missing: 'automation_subject_projection' }> | null;
    loadMore(): Promise<void>;
    reload(): Promise<void>;
}>;

const IDLE: PickerState = { items: [], status: 'idle', coverage: 'unknown', nextCursor: null, error: null };
const DATABASE_PROJECTION = { owner: 'database', missing: 'automation_subject_projection' } as const;

function hasActionReader(input: PickerRequest): input is ReadableRequest {
    return input.kind.kind !== 'database';
}

/**
 * A mounted picker owns only its demanded pages. The list Action owns identities,
 * coverage and admission; no capability or reachability is inferred from a row.
 * Plugin page demand is required by its canonical input, with no UI-local limit.
 */
export function useAutomationSubjectPicker(input: AutomationSubjectPickerInput): AutomationSubjectPickerRead {
    const subjectKinds = 'subjectKinds' in input ? input.subjectKinds : undefined;
    // Inputs are typed JSON. Equal inline kind/page objects name the same sequence
    // and must not restart acquisition on an unrelated render.
    const key = JSON.stringify({ kind: input.kind, ...('page' in input ? { page: input.page }
        : 'databaseScope' in input ? { databaseScope: input.databaseScope }
            : { query: 'query' in input ? input.query : undefined, limit: 'limit' in input ? input.limit : undefined }) });
    const session = React.useMemo(() => ({ input, active: false, request: null as AbortController | null,
        state: input.demanded && input.lifetime && !hasActionReader(input)
            ? { ...IDLE, status: 'unsupported' as const } : IDLE }),
    [key, input.lifetime, input.demanded, input.context, subjectKinds]);
    const [published, setPublished] = React.useState({ session, state: session.state });
    const publish = React.useCallback((state: PickerState) => {
        session.state = state;
        setPublished({ session, state });
    }, [session]);

    const load = React.useCallback(async (more: boolean) => {
        const current = session.input;
        if (!session.active || !current.lifetime || !hasActionReader(current)) return;
        const before = session.state;
        if (more && (session.request !== null || before.nextCursor === null)) return;
        session.request?.abort();
        const controller = new AbortController();
        session.request = controller;
        const cursor = more ? before.nextCursor ?? undefined : undefined;
        const continuation = cursor === undefined ? {} : { cursor };
        publish({ ...before, status: more ? 'loading_more' : 'loading', error: null });
        try {
            const caller = { lifetime: current.lifetime, context: current.context, signal: controller.signal };
            const page = await ('subjectKinds' in current
                ? readAutomationSubjectPickerActionPage({ ...caller, kind: current.kind,
                    subjectKinds: current.subjectKinds, page: { ...current.page, ...continuation } })
                : 'page' in current
                    ? readAutomationSubjectPickerActionPage({ ...caller, kind: current.kind, page: { ...current.page, ...continuation } })
                    : readAutomationSubjectPickerActionPage({ ...current, ...caller, ...continuation }));
            if (!session.active || controller.signal.aborted) return;
            session.request = null;
            publish({ items: more ? [...before.items, ...page.items] : page.items, status: 'ready',
                coverage: page.coverage, nextCursor: page.nextCursor, error: null });
        } catch (error) {
            if (!session.active || controller.signal.aborted) return;
            session.request = null;
            publish({ ...before, status: 'error', error });
        }
    }, [session, publish]);

    React.useEffect(() => {
        const { lifetime, demanded } = session.input;
        if (!demanded || !lifetime?.isCurrent() || !hasActionReader(session.input)) return;
        session.active = true;
        const retire = lifetime.onRetire(() => {
            session.active = false;
            session.request?.abort();
            publish(IDLE);
        });
        void load(false);
        return () => {
            session.active = false;
            session.request?.abort();
            retire.dispose();
        };
    }, [session, load, publish]);

    const loadMore = React.useCallback(() => load(true), [load]);
    const reload = React.useCallback(() => load(false), [load]);
    const state = published.session === session ? published.state : session.state;
    return React.useMemo(() => ({ items: state.items, status: state.status, error: state.error,
        coverage: state.coverage, hasMore: state.nextCursor !== null,
        unsupported: state.status === 'unsupported' ? DATABASE_PROJECTION : null, loadMore, reload }),
    [state, loadMore, reload]);
}
