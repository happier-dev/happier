import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';
import type { ReviewEngineListItem } from '@happier-dev/protocol/reviews/reviewEngines';
import { ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { useExecutionRunLauncherOptionsModel } from './useExecutionRunLauncherOptionsModel';
import { applyExecutionRunChildSelection } from './executionRunChildChoice';

it('exposes the applied inherited draft tuple without stamping it into child launch input', async () => {
    const applied = ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'parent-source', modelId: 'applied-model' });
    const hook = await renderHook(() => {
        const [actionInput, setActionInput] = React.useState<Record<string, unknown>>({ permissionMode: 'read_only' });
        const model = useExecutionRunLauncherOptionsModel({
            sessionId: 'session_1', intent: 'delegate', singleTarget: true, actionInput, setActionInput,
            enabledAgentIds: ['codex', 'claude'], executionRunsBackends: {
                codex: { available: true, intents: ['delegate'] }, claude: { available: true, intents: ['delegate'] },
            }, acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } },
            initialBackendTarget: { kind: 'backend', backendId: 'codex' }, fallbackAgentId: 'codex', machineCapabilitiesState: { status: 'idle' },
            inheritedModelSelection: applied,
        });
        return { model, actionInput };
    });
    expect(hook.getCurrent().model.inheritedDraftSelection).toEqual(applied);
    expect(hook.getCurrent().actionInput).not.toHaveProperty('modelSelection');
    const otherTarget = hook.getCurrent().model.backendChoices.find((choice) => choice.backendId === 'claude')?.targetKey;
    expect(otherTarget).toBeTypeOf('string');
    await act(async () => hook.getCurrent().model.onSelectBackend(otherTarget!));
    expect(hook.getCurrent().model.inheritedDraftSelection).toBeNull();
    const parentTarget = hook.getCurrent().model.backendChoices.find((choice) => choice.backendId === 'codex')?.targetKey;
    expect(parentTarget).toBeTypeOf('string');
    await act(async () => hook.getCurrent().model.onSelectBackend(parentTarget!));
    await act(async () => hook.getCurrent().model.onPatch({ modelSelection: null }));
    expect(hook.getCurrent().model.inheritedDraftSelection).toBeNull();
    expect(hook.getCurrent().actionInput).toHaveProperty('modelSelection', null);
});

afterEach(standardCleanup);

function availableReviewEngine(engineId: string): ReviewEngineListItem {
    return { engineId, label: engineId, enabled: true, capabilities: { structuredNarration: true } };
}
const REVIEW_ENGINES = ['claude', 'codex'].map(availableReviewEngine);

it('keeps each reviewer model when another reviewer is added', async () => {
    const selected = ProviderBoundModelRefSchema.parse({
        agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: 'review-source', modelId: 'review-model',
    });
    const hook = await renderHook(() => {
        const [actionInput, setActionInput] = React.useState<Record<string, unknown>>(() => applyExecutionRunChildSelection({
            reviewers: [{ kind: 'engine', engineId: 'claude' }], permissionMode: 'read_only', instructions: 'Review the captured changes',
        }, selected));
        const model = useExecutionRunLauncherOptionsModel({
            sessionId: 'session_1', intent: 'review', actionInput, setActionInput,
            enabledAgentIds: ['claude', 'codex'], executionRunsBackends: null, reviewEngines: REVIEW_ENGINES, acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } },
            initialBackendTarget: null, fallbackAgentId: null, machineCapabilitiesState: { status: 'idle' },
        });
        return { actionInput, model };
    });
    expect(hook.getCurrent().actionInput.reviewers).toEqual([{ kind: 'engine', engineId: 'claude', modelSelection: selected }]);
    await act(async () => hook.getCurrent().model.onPatch({ roleId: 'second_opinion' }));
    const nextReviewer = hook.getCurrent().model.backendChoices.find(choice => choice.backendId === 'codex');
    expect(nextReviewer).toBeDefined();
    await act(async () => hook.getCurrent().model.onSelectBackend(nextReviewer!.targetKey));
    expect(hook.getCurrent().actionInput.reviewers).toEqual([{ kind: 'engine', engineId: 'claude', modelSelection: selected, roleId: 'second_opinion' }, { kind: 'engine', engineId: 'codex' }]);
    expect(hook.getCurrent().actionInput.instructions).toBe('Review the captured changes');
    expect(hook.getCurrent().actionInput).not.toHaveProperty('modelSelection');
});

it('preserves the authored run selection when its required Account catalog is loading', async () => {
    const hook = await renderHook(() => {
        const [actionInput, setActionInput] = React.useState<Record<string, unknown>>({
            backendTargetKeys: ['acpBackend:review-bot'], permissionMode: 'read_only',
        });
        const model = useExecutionRunLauncherOptionsModel({
            sessionId: 'session_1', intent: 'delegate', actionInput, setActionInput,
            enabledAgentIds: [], executionRunsBackends: {},
            acpCatalogSnapshot: { status: 'loading' },
            initialBackendTarget: null, fallbackAgentId: null,
            machineCapabilitiesState: { status: 'idle' },
        });
        return { actionInput, model };
    });
    expect(hook.getCurrent().actionInput.backendTargetKeys).toEqual(['acpBackend:review-bot']);
    expect(hook.getCurrent().model.backendChoices).toEqual([]);
});

it('retains repeated engine models, Session reviewers and requested people when adding an engine', async () => {
    const original = ReviewStartInputSchema.parse({ instructions: 'Review this change', reviewers: [
        { kind: 'engine', engineId: 'claude', modelId: 'first-model' },
        { kind: 'engine', engineId: 'claude', modelId: 'second-model' },
        { kind: 'session', session: { sessionId: 'reviewer-session', serverId: 'review-home' } },
        { kind: 'person', principal: { kind: 'account', accountId: 'reviewer-account' }, required: true },
    ] });
    const hook = await renderHook(() => {
        const [actionInput, setActionInput] = React.useState<Record<string, unknown>>(original);
        const model = useExecutionRunLauncherOptionsModel({ sessionId: 'session_1', intent: 'review', actionInput, setActionInput,
            enabledAgentIds: ['claude', 'codex'], executionRunsBackends: null, reviewEngines: REVIEW_ENGINES, acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } },
            initialBackendTarget: null, fallbackAgentId: null, machineCapabilitiesState: { status: 'idle' } });
        return { actionInput, model };
    });
    const next = hook.getCurrent().model.backendChoices.find(choice => choice.backendId === 'codex')!;
    await act(async () => hook.getCurrent().model.onSelectBackend(next.targetKey));
    expect(hook.getCurrent().actionInput.reviewers).toEqual([...original.reviewers, { kind: 'engine', engineId: 'codex' }]);
    expect(hook.getCurrent().model.targetRequirement).toBeNull();
});

it('authors the exact configured review engine target from the Machine inventory', async () => {
    const engineId = 'agent:happier.agent.custom-acp/custom-acp:definition:review-bot';
    const hook = await renderHook(() => {
        const [actionInput, setActionInput] = React.useState<Record<string, unknown>>({ reviewers: [] });
        const model = useExecutionRunLauncherOptionsModel({ sessionId: 'session_1', intent: 'review', actionInput, setActionInput,
            enabledAgentIds: [], executionRunsBackends: null, reviewEngines: [availableReviewEngine(engineId)],
            acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } },
            initialBackendTarget: null, fallbackAgentId: null, machineCapabilitiesState: { status: 'idle' } });
        return { actionInput, model };
    });
    await act(async () => hook.getCurrent().model.onSelectBackend(engineId));
    expect(hook.getCurrent().actionInput.reviewers).toEqual([{ kind: 'engine', engineId }]);
});

it.each([true, false])('keeps report selection %s explicit through the options owner', async (initial) => {
    const hook = await renderHook(() => {
        const [actionInput, setActionInput] = React.useState<Record<string, unknown>>({
            permissionMode: 'read_only', notifyParentOnCompletion: initial,
        });
        return useExecutionRunLauncherOptionsModel({
            sessionId: 'session_1', intent: 'delegate', actionInput, setActionInput,
            enabledAgentIds: [], executionRunsBackends: {},
            acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } },
            initialBackendTarget: null, fallbackAgentId: null,
            machineCapabilitiesState: { status: 'idle' },
        });
    });
    expect(hook.getCurrent().selectedNotifyParentOnCompletion).toBe(initial);
    await act(async () => hook.getCurrent().onPatch({ notifyParentOnCompletion: !initial }));
    expect(hook.getCurrent().selectedNotifyParentOnCompletion).toBe(!initial);
});

it('keeps the authored reviewers while the Machine has not answered, then settles them against its answer', async () => {
    let reviewEngines: readonly ReviewEngineListItem[] | undefined;
    const hook = await renderHook(() => {
        const [actionInput, setActionInput] = React.useState<Record<string, unknown>>({ reviewers: [{ kind: 'engine', engineId: 'claude' }, { kind: 'engine', engineId: 'codex' }], permissionMode: 'read_only' });
        const model = useExecutionRunLauncherOptionsModel({
            sessionId: 'session_1', intent: 'review', actionInput, setActionInput,
            enabledAgentIds: ['claude', 'codex'], executionRunsBackends: null, reviewEngines,
            acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } },
            initialBackendTarget: { kind: 'backend', backendId: 'claude' }, fallbackAgentId: 'claude',
            machineCapabilitiesState: { status: 'loading' },
        });
        return { actionInput, model };
    });
    expect(hook.getCurrent().actionInput.reviewers).toEqual([{ kind: 'engine', engineId: 'claude' }, { kind: 'engine', engineId: 'codex' }]);
    expect(hook.getCurrent().model.backendChoices.every((choice) => choice.disabled)).toBe(true);
    expect(hook.getCurrent().model.initialBackendChoice).toBeNull();

    reviewEngines = REVIEW_ENGINES;
    await hook.rerender();
    expect(hook.getCurrent().model.backendChoices.map((choice) => choice.disabled)).toEqual([false, false]);
    expect(hook.getCurrent().actionInput.reviewers).toEqual([{ kind: 'engine', engineId: 'claude' }, { kind: 'engine', engineId: 'codex' }]);
});
