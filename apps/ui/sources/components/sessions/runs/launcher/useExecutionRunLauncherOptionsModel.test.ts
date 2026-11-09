import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';

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

it('keeps a chosen reviewer model, then drops it when another reviewer is added', async () => {
    const selected = ProviderBoundModelRefSchema.parse({
        agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: 'review-source', modelId: 'review-model',
    });
    const hook = await renderHook(() => {
        const [actionInput, setActionInput] = React.useState<Record<string, unknown>>(() => applyExecutionRunChildSelection({
            engineIds: ['claude'], permissionMode: 'read_only', instructions: 'Review the captured changes',
        }, selected));
        const model = useExecutionRunLauncherOptionsModel({
            sessionId: 'session_1', intent: 'review', actionInput, setActionInput,
            enabledAgentIds: ['claude', 'codex'], executionRunsBackends: {
                claude: { available: true, intents: ['review'] }, codex: { available: true, intents: ['review'] },
            }, acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } },
            initialBackendTarget: null, fallbackAgentId: null, machineCapabilitiesState: { status: 'idle' },
        });
        return { actionInput, model };
    });
    expect(hook.getCurrent().actionInput.modelSelection).toEqual(selected);
    const nextReviewer = hook.getCurrent().model.backendChoices.find(choice => choice.backendId === 'codex');
    expect(nextReviewer).toBeDefined();
    await act(async () => hook.getCurrent().model.onSelectBackend(nextReviewer!.targetKey));
    expect(hook.getCurrent().actionInput.engineIds).toEqual(['claude', 'codex']);
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
    let machineBackends: Record<string, { available: boolean; intents: string[] }> | null = null;
    const hook = await renderHook(() => {
        const [actionInput, setActionInput] = React.useState<Record<string, unknown>>({ engineIds: ['claude', 'codex'], permissionMode: 'read_only' });
        const model = useExecutionRunLauncherOptionsModel({
            sessionId: 'session_1', intent: 'review', actionInput, setActionInput,
            enabledAgentIds: ['claude', 'codex'], executionRunsBackends: machineBackends,
            acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } },
            initialBackendTarget: { kind: 'backend', backendId: 'claude' }, fallbackAgentId: 'claude',
            machineCapabilitiesState: { status: 'loading' },
        });
        return { actionInput, model };
    });
    expect(hook.getCurrent().actionInput.engineIds).toEqual(['claude', 'codex']);
    expect(hook.getCurrent().model.backendChoices.every((choice) => choice.disabled)).toBe(true);
    expect(hook.getCurrent().model.initialBackendChoice?.backendId).toBe('claude');

    machineBackends = { claude: { available: true, intents: ['review'] }, codex: { available: true, intents: ['review'] } };
    await hook.rerender();
    expect(hook.getCurrent().model.backendChoices.map((choice) => choice.disabled)).toEqual([false, false]);
    expect(hook.getCurrent().actionInput.engineIds).toEqual(['claude', 'codex']);
});
