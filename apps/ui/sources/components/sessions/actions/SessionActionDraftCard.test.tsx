import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { getActionSpec, resolveEffectiveActionInputFields } from '@happier-dev/protocol';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const executeSpy = vi.fn(async () => ({ ok: true as const, result: {} }));
const updateSessionActionDraftInput = vi.fn();
const setSessionActionDraftStatus = vi.fn();
const deleteSessionActionDraft = vi.fn();

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  Platform: { OS: 'web' },
  Dimensions: {
    get: () => ({ width: 1200, height: 800 }),
  },
}));

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({
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
  }),
}));

vi.mock('@/text', () => ({ t: (key: string) => key }));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
  useEnabledAgentIds: () => ['claude'],
}));

vi.mock('@/agents/catalog/catalog', () => ({
  getAgentCore: () => ({ displayNameKey: 'agent.claude' }),
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

vi.mock('@/sync/domains/state/storage', () => ({
  useSession: () => ({ id: 's1', metadata: {} }),
  storage: {
    getState: () => ({
      updateSessionActionDraftInput,
      setSessionActionDraftStatus,
      deleteSessionActionDraft,
    }),
  },
}));

function findPressableByText(tree: renderer.ReactTestRenderer, label: string) {
  const pressables = tree.root.findAllByType('Pressable');
  for (const node of pressables as any[]) {
    const texts = node.findAllByType?.('Text') ?? [];
    if (texts.some((t: any) => t.props?.children === label)) return node;
  }
  return null;
}

describe('SessionActionDraftCard', () => {
  it('submits a valid plan.start draft via the default action executor', async () => {
    executeSpy.mockClear();
    setSessionActionDraftStatus.mockClear();
    deleteSessionActionDraft.mockClear();

    const { SessionActionDraftCard } = await import('./SessionActionDraftCard');

    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'plan.start',
      createdAt: 1,
      status: 'editing',
      input: { backendIds: ['claude'], instructions: 'Plan this.' },
    } as const;

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(React.createElement(SessionActionDraftCard, { sessionId: 's1', draft: draft as any }));
    });

    const start = findPressableByText(tree!, 'Start');
    expect(start).toBeTruthy();

    await act(async () => {
      await start!.props.onPress?.();
    });

    expect(executeSpy).toHaveBeenCalledWith(
      'plan.start',
      { sessionId: 's1', backendIds: ['claude'], instructions: 'Plan this.' },
      { defaultSessionId: 's1' },
    );

    // Should transition to running then succeeded.
    expect(setSessionActionDraftStatus).toHaveBeenCalledWith('s1', 'd1', 'running', null);
    expect(setSessionActionDraftStatus).toHaveBeenCalledWith('s1', 'd1', 'succeeded', null);
    expect(deleteSessionActionDraft).toHaveBeenCalledWith('s1', 'd1');
  });

  it('shows a validation error and does not execute when required inputs are missing', async () => {
    executeSpy.mockClear();
    setSessionActionDraftStatus.mockClear();

    const { SessionActionDraftCard } = await import('./SessionActionDraftCard');

    const draft = {
      id: 'd1',
      sessionId: 's1',
      actionId: 'plan.start',
      createdAt: 1,
      status: 'editing',
      input: { backendIds: ['claude'], instructions: '   ' },
    } as const;

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(React.createElement(SessionActionDraftCard, { sessionId: 's1', draft: draft as any }));
    });

    const start = findPressableByText(tree!, 'Start');
    expect(start).toBeTruthy();

    await act(async () => {
      await start!.props.onPress?.();
    });

    expect(executeSpy).not.toHaveBeenCalled();
    // Error message is schema-driven; don't pin exact wording.
    expect(setSessionActionDraftStatus).toHaveBeenCalledWith('s1', 'd1', 'editing', expect.any(String));
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

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(React.createElement(SessionActionDraftCard, { sessionId: 's1', draft: draft as any }));
    });

    // Only the instructions field should render a TextInput when base.kind=none.
    const inputs = tree!.root.findAllByType('TextInput');
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

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(React.createElement(SessionActionDraftCard, { sessionId: 's1', draft: draft as any }));
    });

    const inputs = tree!.root.findAllByType('TextInput');
    // instructions + configFiles list
    expect(inputs.length).toBe(2);

    const listInput = inputs.find((i: any) => typeof i.props?.onChangeText === 'function' && i.props?.multiline !== true) ?? inputs[1]!;
    await act(async () => {
      listInput.props.onChangeText?.('a.yml, b.yml');
    });

    expect(updateSessionActionDraftInput).toHaveBeenCalledWith('s1', 'd1', { engines: { coderabbit: { configFiles: ['a.yml', 'b.yml'] } } });
  });
});
