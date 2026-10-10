import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { useExecutionRunLauncherOptionsModel } from './useExecutionRunLauncherOptionsModel';

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
