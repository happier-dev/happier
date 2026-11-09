import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { buildExecutionRunActionDraftInputForUi } from '@/sync/domains/actions/buildExecutionRunActionDraftInputForUi';
import { getSessionDraftSnapshot, readSessionLauncherDraftPreviewFromDraft, resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { useExecutionRunLauncherDraft } from './useExecutionRunLauncherDraft';
import { prepareExecutionRunLauncherDraft } from './prepareExecutionRunLauncherDraft';
import { useOpenExecutionRunLauncherDraft } from './useOpenExecutionRunLauncherDraft';
import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const scope = { serverId: 'seed-home', accountId: 'seed-account' };
afterEach(async () => { await standardCleanup(); resetSessionDraftRepositoryForTests(); });

it('opens the existing draft with complete nondefault Action input and text outside the pane resource', async () => {
    const input = buildExecutionRunActionDraftInputForUi({ actionId: 'review.start', sessionId: 's1',
        instructions: 'Check the selected comparison', extra: { engineIds: ['codex', 'claude'], roleId: 'second_opinion',
            permissionMode: 'workspace_write', modelId: 'chosen-model', changeType: 'committed', base: 'main' } });
    const tab = prepareExecutionRunLauncherDraft({ scope, sessionId: 's1', actionId: 'review.start', input });
    const hook = await renderHook(() => useExecutionRunLauncherDraft({ lifetime: { scope, isCurrent: () => true,
        onRetire: () => ({ dispose() {} }) }, sessionId: 's1', draftKey: 'review:second_opinion', createDefaultInput: () => ({}) }));
    expect(hook.getCurrent().actionInput).toEqual(input);
    expect(readSessionLauncherDraftPreviewFromDraft(getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 's1' })?.document, 'review:second_opinion')).toBe(input.instructions);
    expect(tab.resource).toEqual({ kind: 'executionRunLauncher', intent: 'review', roleId: 'second_opinion' });
    expect(getSessionDraftSnapshot({ ...scope, accountId: 'other' }, { kind: 'session', sessionId: 's1' })).toBeNull();
});

it('retains the scoped Run Start in the shared Details owner before its renderer mounts', async () => {
    const scopeId = createSessionPaneScopeId('s1', scope.serverId, null);
    const hook = await renderHook(() => ({
        open: useOpenExecutionRunLauncherDraft(),
        pane: useAppPaneScope(scopeId),
        startScopeId: useAppPaneContext(value => value.detailsStartScopeId),
    }), { wrapper: ({ children }) => <AppPaneProvider>{children}</AppPaneProvider> });
    const input = buildExecutionRunActionDraftInputForUi({ actionId: 'subagents.plan.start', sessionId: 's1', instructions: 'Plan the change' });
    await act(async () => hook.getCurrent().open({ scope, sessionId: 's1', actionId: 'subagents.plan.start', input }));
    const details = hook.getCurrent().pane.scopeState?.details;
    expect(hook.getCurrent().startScopeId).toBe(scopeId);
    expect(details?.tabs.find(tab => tab.key === details.activeTabKey)?.resource).toEqual({
        kind: 'executionRunLauncher', intent: 'plan',
    });
    expect(readSessionLauncherDraftPreviewFromDraft(getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 's1' })?.document, 'plan')).toBe('Plan the change');
    expect(getSessionDraftSnapshot({ ...scope, accountId: 'other' }, { kind: 'session', sessionId: 's1' })).toBeNull();
});
