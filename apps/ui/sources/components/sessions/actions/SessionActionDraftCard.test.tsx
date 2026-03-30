import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getActionSpec, resolveEffectiveActionInputFields } from '@happier-dev/protocol';
import { changeTextTestInstance, findTestInstanceByTypeContainingText, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import {
    installSessionActionsCommonModuleMocks,
    resetSessionActionsCommonModuleMockState,
} from './sessionActionsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type ExecuteResult = { ok: true; result: unknown } | { ok: false; error: string };
const executeSpy = vi.fn<() => Promise<ExecuteResult>>(async () => ({ ok: true, result: {} }));
const updateSessionActionDraftInput = vi.fn();
const setSessionActionDraftStatus = vi.fn();
const deleteSessionActionDraft = vi.fn();

installSessionActionsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            TextInput: 'TextInput',
            Platform: {
                OS: 'web',
                select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? null,
            },
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
            Dimensions: {
                get: () => ({ width: 1200, height: 800 }),
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: any) => {
                if (key === 'session.actionsDraft.validation.requiredField') {
                    return `${String(params?.field ?? 'Field')} is required.`;
                }
                return key;
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    surface: '#111',
                    text: '#eee',
                    textSecondary: '#aaa',
                    divider: '#333',
                    status: { error: '#f00' },
                    button: { primary: { background: '#0a0', tint: '#000' } },
                },
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSession: () => ({ id: 's1', metadata: {} }),
            storage: {
                getState: () => ({
                    updateSessionActionDraftInput,
                    setSessionActionDraftStatus,
                    deleteSessionActionDraft,
                }),
            },
        });
    },
});

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
  useEnabledAgentIds: () => ['claude'],
}));

vi.mock('@/agents/catalog/catalog', () => ({
  AGENT_IDS: ['claude'],
  getAgentCore: () => ({ displayNameKey: 'agent.claude' }),
}));

vi.mock('@/sync/store/hooks', () => ({
  useLocalSetting: () => 1,
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
  useMachineCapabilitiesCache: () => ({ state: { status: 'idle' }, refresh: vi.fn() }),
}));

vi.mock('@/hooks/server/useExecutionRunsBackendsForSession', () => ({
  useExecutionRunsBackendsForSession: () => null,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
  resolveServerIdForSessionIdFromLocalCache: () => null,
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: () => ({
    execute: executeSpy,
  }),
}));

describe('SessionActionDraftCard', () => {
  beforeEach(() => {
    resetSessionActionsCommonModuleMockState();
    vi.resetModules();
    executeSpy.mockClear();
    updateSessionActionDraftInput.mockClear();
    setSessionActionDraftStatus.mockClear();
    deleteSessionActionDraft.mockClear();
  });

  it('submits a valid subagents.plan.start draft via the default action executor', async () => {
    const { SessionActionDraftCard } = await import('./SessionActionDraftCard');

    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'subagents.plan.start',
      createdAt: 1,
      status: 'editing',
      input: { backendTargetKeys: ['agent:claude'], instructions: 'Plan this.' },
    } as const;

    const screen = await renderScreen(React.createElement(SessionActionDraftCard, { sessionId: 's1', draft: draft as any }));
    const start = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'common.start');
    expect(start).toBeTruthy();

    await pressTestInstanceAsync(start, 'common.start');

    expect(executeSpy).toHaveBeenCalledWith(
      'subagents.plan.start',
      { sessionId: 's1', backendTargetKeys: ['agent:claude'], instructions: 'Plan this.' },
      { defaultSessionId: 's1', surface: 'ui_button', placement: 'session_action_menu' },
    );

    // Should transition to running then succeeded.
    expect(setSessionActionDraftStatus).toHaveBeenCalledWith('s1', 'd1', 'running', null);
    expect(setSessionActionDraftStatus).toHaveBeenCalledWith('s1', 'd1', 'succeeded', null);
    expect(deleteSessionActionDraft).toHaveBeenCalledWith('s1', 'd1');
  });

  it('keeps the draft editable when the action execution fails', async () => {
    executeSpy.mockResolvedValueOnce({ ok: false as const, error: 'RPC method not available' });

    const { SessionActionDraftCard } = await import('./SessionActionDraftCard');

    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'subagents.delegate.start',
      createdAt: 1,
      status: 'editing',
      input: { backendTargetKeys: ['agent:claude'], instructions: 'Delegate this.' },
    } as const;

    const screen = await renderScreen(React.createElement(SessionActionDraftCard, { sessionId: 's1', draft: draft as any }));
    const start = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'common.start');
    expect(start).toBeTruthy();

    await pressTestInstanceAsync(start, 'common.start');

    expect(setSessionActionDraftStatus).toHaveBeenCalledWith('s1', 'd1', 'running', null);
    expect(setSessionActionDraftStatus).toHaveBeenCalledWith('s1', 'd1', 'editing', 'RPC method not available');
    expect(deleteSessionActionDraft).not.toHaveBeenCalled();
  });

  it('ignores duplicate start presses while an action launch is already in flight', async () => {
    let resolveExecute: ((value: ExecuteResult) => void) | null = null;
    executeSpy.mockImplementationOnce(
      () =>
        new Promise<ExecuteResult>((resolve) => {
          resolveExecute = resolve;
        }),
    );

    const { SessionActionDraftCard } = await import('./SessionActionDraftCard');

    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'review.start',
      createdAt: 1,
      status: 'editing',
      input: {
        engineIds: ['coderabbit'],
        instructions: 'Review this repository.',
        changeType: 'all',
        base: { kind: 'none' },
      },
    } as const;

    const screen = await renderScreen(React.createElement(SessionActionDraftCard, { sessionId: 's1', draft: draft as any }));
    const start = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'common.start');
    expect(start).toBeTruthy();

    await act(async () => {
      start!.props.onPress?.();
      await pressTestInstanceAsync(start!);
    });

    expect(executeSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveExecute?.({ ok: true, result: {} });
    });

    expect(setSessionActionDraftStatus).toHaveBeenCalledWith('s1', 'd1', 'running', null);
    expect(setSessionActionDraftStatus).toHaveBeenCalledWith('s1', 'd1', 'succeeded', null);
  });

  it('allows retrying a failed draft without recreating it', async () => {
    const { SessionActionDraftCard } = await import('./SessionActionDraftCard');

    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'subagents.delegate.start',
      createdAt: 1,
      status: 'failed',
      error: 'RPC method not available',
      input: { backendTargetKeys: ['agent:claude'], instructions: 'Delegate this.' },
    } as const;

    const screen = await renderScreen(React.createElement(SessionActionDraftCard, { sessionId: 's1', draft: draft as any }));
    const start = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'common.start');
    expect(start).toBeTruthy();
    expect(start!.props.disabled).toBe(false);
  });

  it('disables start and shows a field-aware validation error when required inputs are missing', async () => {
    executeSpy.mockClear();
    setSessionActionDraftStatus.mockClear();

    const { SessionActionDraftCard } = await import('./SessionActionDraftCard');

    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'subagents.plan.start',
      createdAt: 1,
      status: 'editing',
      input: { backendTargetKeys: ['agent:claude'], instructions: '   ' },
    } as const;

    const screen = await renderScreen(React.createElement(SessionActionDraftCard, { sessionId: 's1', draft: draft as any }));
    const start = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'common.start');
    expect(start).toBeTruthy();
    expect(start!.props.disabled).toBe(true);

    const texts = screen.tree.findAllByType('Text');
    expect(texts.some((node: any) => node.props?.children === 'Instructions is required.')).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(setSessionActionDraftStatus).not.toHaveBeenCalled();
  });

  it('maps missing review engine selection to a required-field validation message', async () => {
    executeSpy.mockClear();
    setSessionActionDraftStatus.mockClear();

    const { SessionActionDraftCard } = await import('./SessionActionDraftCard');

    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'review.start',
      createdAt: 1,
      status: 'editing',
      input: { instructions: '', changeType: 'committed', base: { kind: 'none' } },
    } as const;

    const screen = await renderScreen(React.createElement(SessionActionDraftCard, { sessionId: 's1', draft: draft as any }));
    const start = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'common.start');
    expect(start).toBeTruthy();
    expect(start!.props.disabled).toBe(true);

    const texts = screen.tree.findAllByType('Text');
    expect(texts.some((node: any) => node.props?.children === 'Review engines is required.')).toBe(true);
    expect(
      texts.some((node: any) => String(node.props?.children ?? '').includes('Invalid input: expected array, received undefined')),
    ).toBe(false);
  });

  it('clears stale draft errors when the user edits an input', async () => {
    updateSessionActionDraftInput.mockClear();
    setSessionActionDraftStatus.mockClear();

    const { SessionActionDraftCard } = await import('./SessionActionDraftCard');

    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'review.start',
      createdAt: 1,
      status: 'editing',
      error: 'Instructions is required.',
      input: { engineIds: ['claude'], instructions: '', changeType: 'committed', base: { kind: 'none' } },
    } as const;

    const screen = await renderScreen(React.createElement(SessionActionDraftCard, { sessionId: 's1', draft: draft as any }));
    const input = screen.tree.findAllByType('TextInput')[0]!;
    await act(async () => {
      changeTextTestInstance(input, 'Review this.');
    });

    expect(updateSessionActionDraftInput).toHaveBeenCalledWith('s1', 'd1', { instructions: 'Review this.' });
    expect(setSessionActionDraftStatus).toHaveBeenCalledWith('s1', 'd1', 'editing', null);
  });

  it('hides conditional review base fields when base.kind is none', async () => {
    // Sanity: protocol-level rule evaluation should hide base branch/commit for base.kind=none.
    const spec = getActionSpec('review.start' as any);
    const effective = resolveEffectiveActionInputFields(spec as any, {
      engineIds: ['claude'],
      instructions: 'Review',
      changeType: 'committed',
      base: { kind: 'none' },
    });
    expect(effective.map((f: any) => f.path)).not.toContain('base.baseBranch');

    const { SessionActionDraftCard } = await import('./SessionActionDraftCard');

    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'review.start',
      createdAt: 1,
      status: 'editing',
      input: { engineIds: ['claude'], instructions: 'Review', changeType: 'committed', base: { kind: 'none' } },
    } as const;

    const screen = await renderScreen(React.createElement(SessionActionDraftCard, { sessionId: 's1', draft: draft as any }));

    // Only the instructions field should render a TextInput when base.kind=none.
    const inputs = screen.tree.findAllByType('TextInput');
    expect(inputs.length).toBe(1);
  });

  it('parses text_list input into a string array patch', async () => {
    updateSessionActionDraftInput.mockClear();

    const { SessionActionDraftCard } = await import('./SessionActionDraftCard');

    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'review.start',
      createdAt: 1,
      status: 'editing',
      input: {
        engineIds: ['coderabbit'],
        instructions: 'Review',
        changeType: 'committed',
        base: { kind: 'none' },
        engines: { coderabbit: { configFiles: [] } },
      },
    } as const;

    const screen = await renderScreen(React.createElement(SessionActionDraftCard, { sessionId: 's1', draft: draft as any }));

    const inputs = screen.tree.findAllByType('TextInput');
    // instructions + configFiles list
    expect(inputs.length).toBe(2);

    const listInput = inputs.find((i: any) => typeof i.props?.onChangeText === 'function' && i.props?.multiline !== true) ?? inputs[1]!;
    await act(async () => {
      changeTextTestInstance(listInput, 'a.yml, b.yml');
    });

    expect(updateSessionActionDraftInput).toHaveBeenCalledWith('s1', 'd1', { engines: { coderabbit: { configFiles: ['a.yml', 'b.yml'] } } });
  });
});
