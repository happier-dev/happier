import * as React from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { McpServerCatalogEntryV1Schema, type McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { ReachRulesChangeV1Schema, reachRulesToDraftsV1, type ReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';

import { useDraftReachRules, type WhereItsOnControlProps } from '@/components/capabilities/where/WhereItsOnControl';
import { randomUUID } from '@/platform/randomUUID';
import { requireUpdatedMcpServerCatalogMutation } from '@/sync/api/account/apiMcpServerCatalog';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';
import type { useMcpServersSettings } from '../useMcpServersSettings';

type Catalog = Pick<ReturnType<typeof useMcpServersSettings>, 'settings' | 'snapshot' | 'scope' | 'writable' | 'mutate'>;
type DraftState = Readonly<{
    server: McpServerCatalogEntryV1;
    dirty: boolean;
    busy: boolean;
    addedId: string | null;
    error: string | null;
}>;

export type McpServerDraft = Readonly<{
    store: StoreApi<DraftState>;
    initialName: string;
    scope: AccountSettingsScope | null;
    current: boolean;
    resolving: boolean;
    writable: boolean;
    reach: Readonly<{ rules: ReachRulesV1; where: ReachRulesChangeV1 | undefined; onChange: WhereItsOnControlProps['onChange'] }>;
    changeServer: (update: (server: McpServerCatalogEntryV1) => McpServerCatalogEntryV1) => void;
    create: () => Promise<string | null>;
    reset: () => void;
}>;

function createDefaultServerName(existingNames: ReadonlySet<string>): string {
    let name = 'server';
    if (existingNames.has(name)) {
        name = `server_${Date.now()}`;
        for (let index = 2; index < 999; index += 1) {
            const candidate = `server_${index}`;
            if (!existingNames.has(candidate)) { name = candidate; break; }
        }
    }
    return name;
}

function createDraftServer(existingNames: ReadonlySet<string>): McpServerCatalogEntryV1 {
    const name = createDefaultServerName(existingNames);
    const now = Date.now();
    return { id: randomUUID(), name, transport: 'stdio', stdio: { command: '', args: [] }, env: {}, createdAt: now, updatedAt: now };
}

export type McpAddBinding = Readonly<{
    /** The Account settings scope captured when the Add surface opened. */
    scope: AccountSettingsScope | null;
    isCurrent: () => boolean;
    current: boolean;
    resolving: boolean;
}>;

/** The one Account binding an Add surface writes under: captured once, current while the catalog keeps that scope. */
export function useMcpAddBinding(scope: AccountSettingsScope | null): McpAddBinding {
    const liveScope = React.useRef(scope);
    liveScope.current = scope;
    const capturedScope = React.useRef(scope);
    if (!capturedScope.current && scope) capturedScope.current = scope;
    const { binding, resolution } = useServerCredentialAccountScopeBinding(capturedScope.current?.serverId);
    const capturedBinding = React.useRef<ServerCredentialAccountScopeBinding | null>(null);
    if (!capturedBinding.current && binding && areAccountSettingsScopesEqual(binding.scope, capturedScope.current)) {
        capturedBinding.current = binding;
    }
    const isCurrent = React.useCallback(() => capturedBinding.current?.isCurrent() === true
        && areAccountSettingsScopesEqual(capturedScope.current, liveScope.current), []);
    return { scope: capturedScope.current, isCurrent, current: isCurrent(),
        resolving: capturedBinding.current === null && resolution.kind === 'resolving' };
}

/** Creation state outlives its visible input, without retaining Secret/place readers or rerendering the catalog on typing. */
export function useMcpServerDraft(catalog: Catalog, binding: McpAddBinding): McpServerDraft {
    const liveCatalog = React.useRef(catalog);
    liveCatalog.current = catalog;
    const [initial, setInitial] = React.useState(() => createDraftServer(new Set(catalog.settings.servers.map(server => server.name))));
    const [store] = React.useState(() => createStore<DraftState>(() => ({ server: initial, dirty: false, busy: false, addedId: null, error: null })));
    const reach = useDraftReachRules('mcp_server');
    const [initialReach] = React.useState(() => reachRulesToDraftsV1(reach.rules));
    const liveReach = React.useRef(reach);
    liveReach.current = reach;
    const inFlight = React.useRef<Promise<string | null> | null>(null);
    const { isCurrent } = binding;
    React.useEffect(() => {
        const current = store.getState();
        if (!isCurrent() || !catalog.writable || current.busy || current.addedId || current.server.name !== initial.name) return;
        const names = new Set(catalog.settings.servers.map(server => server.name));
        if (!names.has(initial.name)) return;
        const name = createDefaultServerName(names);
        setInitial(base => ({ ...base, name }));
        store.setState({ server: { ...current.server, name } });
    }, [catalog.settings.servers, catalog.writable, initial.name, isCurrent, store]);
    const changeServer = React.useCallback((update: (server: McpServerCatalogEntryV1) => McpServerCatalogEntryV1) => {
        if (!isCurrent() || store.getState().busy || store.getState().addedId) return;
        const previous = store.getState();
        const server = update(previous.server);
        if (sameStrictJsonValue({ ...previous.server, updatedAt: 0 }, { ...server, updatedAt: 0 })) return;
        const dirty = !sameStrictJsonValue(reachRulesToDraftsV1(liveReach.current.rules), initialReach)
            || !sameStrictJsonValue({ ...server, updatedAt: 0 }, { ...initial, updatedAt: 0 });
        store.setState({ server, dirty, error: null });
    }, [initial, initialReach, isCurrent, store]);
    const changeReach = React.useCallback<typeof reach.onChange>(async change => {
        if (!isCurrent() || store.getState().busy || store.getState().addedId) return { ok: false, message: t('common.unavailable') };
        const result = await liveReach.current.onChange(change);
        if (result.ok) store.setState(current => {
            const dirty = !sameStrictJsonValue(change.rules, initialReach)
                || !sameStrictJsonValue({ ...current.server, updatedAt: 0 }, { ...initial, updatedAt: 0 });
            return current.dirty === dirty ? current : { ...current, dirty };
        });
        return result;
    }, [initial, initialReach, isCurrent, store]);
    const create = React.useCallback((): Promise<string | null> => {
        if (store.getState().addedId) return Promise.resolve(isCurrent() ? store.getState().addedId : null);
        if (inFlight.current) return inFlight.current;
        const current = liveCatalog.current;
        const parsed = McpServerCatalogEntryV1Schema.safeParse(store.getState().server);
        if (!isCurrent() || !current.writable || current.snapshot.revision === 'absent' || !parsed.success) return Promise.resolve(null);
        store.setState({ busy: true, error: null });
        const operation = (async () => {
            try {
                const receipt = await current.mutate('mcp.servers.create', {
                    entry: parsed.data,
                    expectedRevision: current.snapshot.revision,
                    ...(liveReach.current.where ? { where: ReachRulesChangeV1Schema.parse(liveReach.current.where) } : {}),
                });
                requireUpdatedMcpServerCatalogMutation(receipt);
                if (!('serverId' in receipt)) throw new Error('invalid_action_output');
                // Keep acknowledged custody even if its Account retired while the Action was pending.
                store.setState({ addedId: receipt.serverId, dirty: false });
                return isCurrent() ? receipt.serverId : null;
            } catch (error) {
                if (isCurrent()) store.setState({ error: error instanceof Error ? error.message : t('errors.unknownError') });
                return null;
            } finally {
                store.setState({ busy: false });
                inFlight.current = null;
            }
        })();
        inFlight.current = operation;
        return operation;
    }, [isCurrent, store]);
    const reset = React.useCallback(() => {
        if (store.getState().busy || store.getState().addedId) return;
        void liveReach.current.onChange({ kind: 'replace', rules: initialReach });
        store.setState({ server: initial, dirty: false, error: null });
    }, [initial, initialReach, store]);
    return { store, initialName: initial.name, scope: binding.scope, current: binding.current,
        resolving: binding.resolving, writable: catalog.writable !== null,
        reach: { ...reach, onChange: changeReach }, changeServer, create, reset };
}


export function useMcpDraftDirty(draft: McpServerDraft) {
    return useStore(draft.store, state => draft.current && state.dirty);
}
