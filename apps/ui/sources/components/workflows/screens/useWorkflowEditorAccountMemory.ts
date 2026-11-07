import * as React from 'react';
import { getStorage } from '@/sync/domains/state/storage';
import { readProjectWorkspaceRefs } from '@/sync/store/domains/projectAccountRows';
import { useApplyAuthoringMemoryDelta } from '@/sync/store/settingsWriters';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createAuthoringMemorySyncInContext } from '@/sync/api/account/apiAuthoringMemory';
import { authoringMemoryDefaults } from '@/sync/store/domains/authoringMemory';
import type { AuthoringMemoryDelta } from '@/sync/engine/authoringMemory/authoringMemorySync';
import { createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';
import { fireAndForget } from '@/utils/system/fireAndForget';

const EMPTY_WORKSPACES: readonly WorkspaceRefV1[] = Object.freeze([]);

/** Local display projection; the existing memory domain owns reads, encryption and CAS writes. */
export function useWorkflowEditorAccountMemory(accountLifetime?: ServerAccountScopeLifetime | null,
    demand?: Readonly<{ workspaceRefs: boolean }>) {
    const readWorkspaces = demand?.workspaceRefs !== false;
    accountLifetime = useWorkflowAccountLifetime(accountLifetime);
    const useActiveMemory = accountLifetime === undefined;
    const activeRecent = getStorage()(state => useActiveMemory ? state.authoringMemory.recentMachinePaths : authoringMemoryDefaults.recentMachinePaths);
    const activeProjects = getStorage()(state => useActiveMemory ? state.authoringMemory.workflowProjectTargetsByDefinitionId : authoringMemoryDefaults.workflowProjectTargetsByDefinitionId);
    const activeWorkspaceRefs = getStorage()(state => useActiveMemory && readWorkspaces ? readProjectWorkspaceRefs(state) : EMPTY_WORKSPACES);
    const applyActive = useApplyAuthoringMemoryDelta();
    const [state, setState] = React.useState(() => ({ lifetime: accountLifetime, memory: authoringMemoryDefaults }));
    const [owner, setOwner] = React.useState<Readonly<{ lifetime: ServerAccountScopeLifetime;
        memory: Awaited<ReturnType<typeof createAuthoringMemorySyncInContext>> }> | null>(null);
    const [workspaces, setWorkspaces] = React.useState<Readonly<{ lifetime: ServerAccountScopeLifetime;
        refs: readonly WorkspaceRefV1[] }> | null>(null);
    React.useEffect(() => {
        if (!accountLifetime?.isCurrent()) return;
        let disposed = false;
        const controller = new AbortController();
        const retirement = accountLifetime.onRetire(() => controller.abort());
        let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
        void (async () => {
            account = await captureLazyActionAccountContext(accountLifetime.scope.serverId, controller.signal);
            if (disposed) { account.dispose(); return; }
            account.assertCurrent();
            if (!accountLifetime.isCurrent() || !areServerAccountScopesEqual(account.accountLifetime.scope, accountLifetime.scope)) {
                account.dispose(); return;
            }
            const isCurrent = () => !disposed && accountLifetime.isCurrent() && account?.accountLifetime.isCurrent() === true;
            if (readWorkspaces) void createUiProjectAccountRowsClient(account).read(controller.signal).then(snapshot => {
                if (isCurrent()) setWorkspaces({ lifetime: accountLifetime, refs: snapshot.workspaceRefs });
            }).catch(() => { /* An unavailable census cannot contribute another Account's checkouts. */ });
            const memory = await createAuthoringMemorySyncInContext(account, {
                isCurrent,
                apply: delta => setState(current => ({ lifetime: accountLifetime,
                    memory: { ...(current.lifetime === accountLifetime ? current.memory : authoringMemoryDefaults), ...delta } })),
            });
            await memory.bootstrap();
            if (isCurrent()) setOwner({ lifetime: accountLifetime, memory });
        })().catch(() => { /* A failed memory read never borrows the focused Account's placement. */ });
        return () => { disposed = true; controller.abort(); retirement.dispose(); account?.dispose(); };
    }, [accountLifetime, readWorkspaces]);
    // Remembering a personal target is a convenience, never part of definition Save.
    // An unavailable addressed reader cannot borrow the focused Account's writer.
    const remember = React.useCallback((delta: AuthoringMemoryDelta) => {
        if (accountLifetime === undefined) {
            fireAndForget(applyActive(delta), { tag: 'WorkflowEditor.rememberTarget' });
            return;
        }
        if (!accountLifetime?.isCurrent() || owner?.lifetime !== accountLifetime) return;
        fireAndForget(owner.memory.applyDelta(delta), { tag: 'WorkflowEditor.rememberTarget' });
    }, [accountLifetime, applyActive, owner]);
    const memory = state.lifetime === accountLifetime ? state.memory : authoringMemoryDefaults;
    return accountLifetime === undefined
        ? { recentMachinePaths: activeRecent, workflowProjectTargetsByDefinitionId: activeProjects, workspaceRefs: readWorkspaces ? activeWorkspaceRefs : EMPTY_WORKSPACES, remember }
        : { recentMachinePaths: memory.recentMachinePaths, workflowProjectTargetsByDefinitionId: memory.workflowProjectTargetsByDefinitionId,
            workspaceRefs: readWorkspaces && workspaces?.lifetime === accountLifetime ? workspaces.refs : EMPTY_WORKSPACES, remember };
}
