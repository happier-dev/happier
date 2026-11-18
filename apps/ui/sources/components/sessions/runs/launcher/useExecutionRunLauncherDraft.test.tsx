import { afterEach, expect, it } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { getSessionDraftSnapshot, resetSessionDraftRepositoryForTests, writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { executionRunLauncherDraftKey } from '@/components/sessions/agents/launch/agentStartDrafts';
import { readExecutionRunLauncherComparisonReview, useExecutionRunLauncherDraft } from './useExecutionRunLauncherDraft';
import { createSessionScmReviewDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import type { ComparisonReviewDraftInput } from './useComparisonReviewDraft';

const scope = { serverId: 'launcher-home', accountId: 'launcher-account' };
const sessionId = 'delayed-launcher';
const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
const address = { kind: 'session' as const, sessionId };

afterEach(async () => { await standardCleanup(); resetSessionDraftRepositoryForTests(); });

it('restores one comparison draft capture after opening another comparison source', async () => {
    const branch: ComparisonReviewDraftInput = { cwd: '/repo', comparison: { kind: 'branch', base: 'main', head: 'HEAD' },
        scopeLabel: 'main → HEAD', defaultWalkthrough: true,
        origin: { scopeId: 'session:delayed-launcher', tab: createSessionScmReviewDetailsTab({
            comparison: { kind: 'branch', base: 'main', head: 'HEAD' }, explain: true,
        }) } };
    const pending: ComparisonReviewDraftInput = { ...branch, comparison: { kind: 'workingTree' }, scopeLabel: 'Pending changes' };
    const hook = await renderHook((comparisonReview: ComparisonReviewDraftInput) => useExecutionRunLauncherDraft({
        lifetime, sessionId, comparisonReview, draftKey: executionRunLauncherDraftKey({ intent: 'review', comparisonReview }),
        createDefaultInput: () => ({}),
    }), { initialProps: branch });
    await act(async () => hook.getCurrent().setUserActionInput({ comparisonId: 'captured-branch' }));
    expect(readExecutionRunLauncherComparisonReview(getSessionDraftSnapshot(scope, address)?.document ?? null,
        executionRunLauncherDraftKey({ intent: 'review', comparisonReview: branch }))).toEqual(branch);
    await hook.rerender(pending);
    expect(hook.getCurrent().actionInput.comparisonId).toBeUndefined();
    await act(async () => hook.getCurrent().setUserActionInput({ comparisonId: 'captured-pending' }));
    await hook.rerender(branch);
    expect(hook.getCurrent().actionInput.comparisonId).toBe('captured-branch');
});

it('ignores malformed comparison context when reopening a retained draft', async () => {
    const hook = await renderHook(() => useExecutionRunLauncherDraft({ lifetime, sessionId, draftKey: 'review',
        createDefaultInput: () => ({}),
    }));
    await act(async () => hook.getCurrent().setUserActionInput({ reviewers: [{ kind: 'engine', engineId: 'claude' }] }));
    const document = getSessionDraftSnapshot(scope, address)?.document;
    const malformed = { cwd: '/repo', comparison: { kind: 'branch', base: 42, head: 'HEAD' },
        scopeLabel: 'Changes', defaultWalkthrough: true };
    await act(async () => writeExistingSessionDraft({ scope, sessionId,
        patch: { executionRunLauncher: { key: 'review', patch: { selection: {
            identity: hook.getCurrent().identity, actionInput: { reviewers: [{ kind: 'engine', engineId: 'claude' }] }, comparisonReview: malformed,
        } } } } }));
    expect(document).not.toBeNull();
    expect(readExecutionRunLauncherComparisonReview(getSessionDraftSnapshot(scope, address)?.document ?? null, 'review')).toBeNull();
});

it('keeps detached launcher selections editable without Session draft currentness', async () => {
    const hook = await renderHook(() => useExecutionRunLauncherDraft({ lifetime, sessionId: null,
        draftKey: 'conversation', createDefaultInput: () => ({ modelId: 'default' }) }));
    await act(async () => hook.getCurrent().setUserActionInput({ modelId: 'chosen' }));
    expect(hook.getCurrent().actionInput).toEqual({ modelId: 'chosen' });
    expect(hook.getCurrent().captureSelection()).toBeNull();
});

it('restores historical review selections through the canonical roster decoder without writing during hydration', async () => {
    writeExistingSessionDraft({ scope, sessionId, patch: { executionRunLauncher: { key: 'review', patch: { selection: {
        identity: { correlationId: 'historical-review', inputLocalId: 'historical-input' },
        actionInput: { engineIds: ['claude'], instructions: '', modelId: 'selected-model',
            includeSessionTranscript: true, sourceSession: { sessionId, serverId: scope.serverId } },
    } } } } });
    const saved = getSessionDraftSnapshot(scope, address);
    const hook = await renderHook(() => useExecutionRunLauncherDraft({ lifetime, sessionId, draftKey: 'review',
        actionId: 'review.start', createDefaultInput: () => ({}) }));
    expect(hook.getCurrent().actionInput).toMatchObject({
        instructions: '', reviewers: [{ kind: 'engine', engineId: 'claude', modelId: 'selected-model' }],
        includeSessionTranscript: true, sourceSession: { sessionId, serverId: scope.serverId },
    });
    expect(hook.getCurrent().actionInput).not.toHaveProperty('engineIds');
    expect(getSessionDraftSnapshot(scope, address)).toBe(saved);
});

it('checkpoints the first document edit without committing an unchanged launcher selection', async () => {
    let renders = 0;
    const hook = await renderHook(() => {
        renders += 1;
        return useExecutionRunLauncherDraft({ lifetime, sessionId,
            draftKey: 'conversation', createDefaultInput: () => ({ backendTargetKeys: ['agent:claude'] }) });
    });
    const initial = hook.getCurrent();
    const settledRenders = renders;
    await act(async () => initial.onDocumentEdit());
    expect(hook.getCurrent().captureSelection()).not.toBeNull();
    expect(renders - settledRenders).toBe(0);
    expect(hook.getCurrent().identity).toBe(initial.identity);
    await act(async () => hook.getCurrent().setUserActionInput({ backendTargetKeys: ['agent:codex'] }));
    expect(hook.getCurrent().actionInput).toEqual({ backendTargetKeys: ['agent:codex'] });
});

it('adopts selection and identity arriving after mount without rewriting the hydrated field', async () => {
    let renders = 0;
    const hook = await renderHook(() => {
        renders += 1;
        return useExecutionRunLauncherDraft({ lifetime, sessionId,
            draftKey: 'conversation', createDefaultInput: () => ({ backendTargetKeys: ['agent:claude'] }) });
    });
    expect(getSessionDraftSnapshot(scope, address)).toBeNull();
    const selection = { identity: { correlationId: 'retained-correlation', inputLocalId: 'retained-input' },
        actionInput: { backendTargetKeys: ['agent:codex'], modelSelection: { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'chosen-model' } } };
    await act(async () => writeExistingSessionDraft({ scope, sessionId, patch: { executionRunLauncher: {
        key: 'conversation', patch: { text: 'Arrived after mount', selection },
    } } }));
    const hydrated = getSessionDraftSnapshot(scope, address);
    expect(hook.getCurrent().identity).toEqual(selection.identity);
    expect(hook.getCurrent().actionInput).toEqual(selection.actionInput);
    expect(getSessionDraftSnapshot(scope, address)).toBe(hydrated);
    const settledRenders = renders;
    await act(async () => writeExistingSessionDraft({ scope, sessionId, patch: { executionRunLauncher: {
        key: 'conversation', patch: { text: 'Typing stays in the composer leaf' },
    } } }));
    expect(renders).toBe(settledRenders);
});

it('preserves a newer explicit choice when an earlier send is accepted and isolates Account, Home and intent', async () => {
    const hook = await renderHook((props: { lifetime: typeof lifetime; draftKey: string }) => useExecutionRunLauncherDraft({
        ...props, sessionId, createDefaultInput: () => ({ modelId: 'default' }),
    }), { initialProps: { lifetime, draftKey: 'conversation' } });
    await act(async () => hook.getCurrent().setUserActionInput({ modelId: 'first' }));
    const captured = hook.getCurrent().captureSelection();
    await act(async () => hook.getCurrent().setUserActionInput({ modelId: 'newer' }));
    await act(async () => hook.getCurrent().clearAcceptedSelection(captured, { text: '', mentions: [], attachments: [] }));
    expect(hook.getCurrent().actionInput).toEqual({ modelId: 'newer' });
    for (const isolated of [
        { ...lifetime, scope: { ...scope, accountId: 'other-account' } },
        { ...lifetime, scope: { ...scope, serverId: 'other-home' } },
    ]) {
        await hook.rerender({ lifetime: isolated, draftKey: 'conversation' });
        expect(hook.getCurrent().actionInput).toEqual({ modelId: 'default' });
    }
    await hook.rerender({ lifetime, draftKey: 'plan' });
    expect(hook.getCurrent().actionInput).toEqual({ modelId: 'default' });
    await hook.rerender({ lifetime, draftKey: 'conversation' });
    expect(hook.getCurrent().actionInput).toEqual({ modelId: 'newer' });
    const accepted = hook.getCurrent().captureSelection();
    await act(async () => hook.getCurrent().clearAcceptedSelection(accepted, { text: '', mentions: [], attachments: [] }));
    expect(hook.getCurrent().actionInput).toEqual({ modelId: 'default' });
});
