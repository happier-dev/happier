import * as React from 'react';
import { vi, it, expect } from 'vitest';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionListQuerySourceHarness } from '@/dev/testkit/harness/sessionListQuerySourceHarness';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { ReviewStartBody } from './ReviewStartBody';
import { ReviewStartInputSchema, reviewReviewerIdForSelectionV1 } from '@happier-dev/protocol/reviews/reviewStart';
import { ScmComparisonSourceSchema } from '@happier-dev/protocol/scm/comparison';
import { SelectionList } from '@/components/ui/selectionList';
import { t } from '@/text';
import { resolveExecutionRunLauncherBackendChoices } from './resolveExecutionRunLauncherBackendChoices';
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness'))
    .createSocketIoClientBoundary(importOriginal));

it('authors a required person without changing the other reviewers or step Focus', async () => {
    const boundary = await createSessionListQuerySourceHarness();
    try {
        const home = boundary.serverIds[1]!;
        const scope = await renderHook(() => useServerCredentialAccountScopeBindings([home]));
        await vi.waitFor(() => expect(scope.getCurrent().get(home)?.isCurrent()).toBe(true));
        const accountLifetime = scope.getCurrent().get(home)!;
        boundary.setRows(home, []);
        boundary.http.answer(home, '/v1/user/profiles', { body: { users: [] } });
        let current: Record<string, unknown> = {};
        function Draft() {
            const [input, onChange] = React.useState<Record<string, unknown>>({
                reviewers: [{ kind: 'engine', engineId: 'claude' },
                    { kind: 'person', principal: { kind: 'account', accountId: 'alice' }, required: false }],
                steps: [{ kind: 'review', instructions: 'Check the changed code', reviewers: [
                    { kind: 'engine', engineId: 'claude' },
                    { kind: 'person', principal: { kind: 'account', accountId: 'alice' }, required: false },
                ] }],
            });
            current = input;
            return <ReviewStartBody input={input} onChange={onChange}
                source={{ enabled: true, sections: [], selectedIds: new Set(),
                    where: { accountLifetime, target: null, machineName: null, testIDPrefix: 'review-start' } }}
                choices={[]} transcriptAvailable={false} walkthrough={false} disabled={false} />;
        }
        const screen = await renderScreen(<Draft />);
        await vi.waitFor(() => expect(screen.findByTestId('review-start-required:account:alice')).not.toBeNull());
        await screen.pressByTestIdAsync('review-start-required:account:alice');
        await vi.waitFor(() => expect(screen.findHostByTestId('review-start-required:account:alice')?.props['aria-checked']).toBe(true));
        expect(current.steps).toMatchObject([{ instructions: 'Check the changed code', reviewers: [
            { kind: 'engine', engineId: 'claude' }, { kind: 'person', required: true },
        ] }]);
        await screen.pressByTestIdAsync('review-start-required:account:alice');
        await vi.waitFor(() => expect(screen.findHostByTestId('review-start-required:account:alice')?.props['aria-checked']).toBe(false));
        expect(current.reviewers).toMatchObject([{ kind: 'engine', engineId: 'claude' }, { kind: 'person', required: false }]);
        await screen.unmount();
        await scope.unmount();
    } finally { await standardCleanup(); await boundary.dispose(); }
});

const codexTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
const claudeTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
const runnerChoices = resolveExecutionRunLauncherBackendChoices({ intent: 'review', enabledAgentIds: ['codex', 'claude'], executionRunsBackends: {},
    reviewEngines: [
        { engineId: 'codex', value: 'agent:happier.agent.codex/codex', label: 'Codex', enabled: true, capabilities: { structuredNarration: false } },
        { engineId: 'claude', value: 'agent:happier.agent.claude/claude', label: 'Claude', enabled: true, capabilities: { structuredNarration: false } },
        { engineId: 'roborev', label: 'roborev', enabled: true,
            capabilities: { structuredNarration: true }, runnerSelection: 'perMember', runnerAgents: [
                { agentTarget: codexTarget, providerProtocols: ['openai-responses'] },
                { agentTarget: claudeTarget, providerProtocols: ['anthropic'] },
            ] },
    ] });

it('names each panel member and its own runner and model in the Who summary', async () => {
    const reviewers = [
        { kind: 'engine', engineId: 'roborev', runnerAgentTarget: codexTarget },
        { kind: 'engine', engineId: 'roborev', runnerAgentTarget: claudeTarget,
            modelSelection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'review-model' } },
    ];
    const props: React.ComponentProps<typeof ReviewStartBody> = { input: { reviewers },
        onChange: () => undefined, source: { enabled: true, where: null, selectedIds: new Set(['roborev']),
        sections: [{ category: 'engine', section: { kind: 'static', id: 'engines', options: [
            { id: runnerChoices[2]!.targetKey, label: 'roborev', onSelect: () => undefined },
        ] } }] }, choices: runnerChoices, transcriptAvailable: false, walkthrough: false, disabled: false };
    const screen = await renderScreen(<ReviewStartBody {...props} />);
    const options = () => screen.findAllByType(SelectionList).find(node => node.props.testID === 'contextual-start-who')!
        .props.rootStep.sections.flatMap((section: { options?: readonly unknown[] }) => section.options ?? []);
    const expected = expect.arrayContaining([
        expect.objectContaining({ label: 'roborev 1', subtitle: `Codex · ${t('agentInput.model.useCliSettings')}` }),
        expect.objectContaining({ label: 'roborev 2', subtitle: 'Claude · review-model' }),
    ]);
    expect(options()).toEqual(expected);
    // The ready engine's native runner still has its catalog name without a standalone reviewer row.
    await screen.update(<ReviewStartBody {...props} choices={[runnerChoices[2]!]} />);
    expect(options()).toEqual(expected);
    const inheritedModel = { selection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null,
        modelId: 'session-model' }, label: 'Session model' };
    await screen.update(<ReviewStartBody {...props} inheritedModel={inheritedModel} />);
    expect(options()).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: 'roborev 1', subtitle: 'Codex · Session model' }),
        expect.objectContaining({ label: 'roborev 2', subtitle: 'Claude · review-model' }),
    ]));
    await screen.update(<ReviewStartBody {...props} inheritedModel={{ ...inheritedModel,
        selection: { ...inheritedModel.selection, agentTargetKey: 'agent:happier.agent.claude/claude' } }} />);
    expect(options()).toEqual(expected);
    await screen.update(<ReviewStartBody {...props} inheritedModel={inheritedModel} input={{ reviewers: [
        { kind: 'engine', engineId: 'roborev', runnerAgentTarget: codexTarget, childSelection: 'agentDefault' },
        reviewers[1],
    ] }} />);
    expect(options()).toEqual(expected);
    await screen.unmount();
});

it('selects a newly checked engine with its first available declared runner', async () => {
    let input: Record<string, unknown> = { reviewers: [] };
    const screen = await renderScreen(<ReviewStartBody input={input} onChange={update => {
        input = typeof update === 'function' ? update(input) : update;
    }} source={{ enabled: true, where: null, selectedIds: new Set(),
        sections: [{ category: 'engine', section: { kind: 'static', id: 'engines', options: [
            { id: runnerChoices[2]!.targetKey, testID: 'select-panel', label: 'roborev', onSelect: () => undefined },
        ] } }] }} choices={runnerChoices} transcriptAvailable={false} walkthrough={false} disabled={false} />);
    await screen.pressByTestIdAsync('select-panel');
    expect(input.reviewers).toEqual([{ kind: 'engine', engineId: 'roborev', runnerAgentTarget: codexTarget }]);
    await screen.unmount();
});
it('removes one configured engine occurrence while retaining the other occurrence and person', async () => {
    const first = { kind: 'engine', engineId: 'claude', modelId: 'first-model' };
    const second = { kind: 'engine', engineId: 'claude', modelId: 'second-model' };
    const person = { kind: 'person', principal: { kind: 'account', accountId: 'alice' }, required: true };
    let input: Record<string, unknown> = { reviewers: [first, second, person] };
    const onChange: React.Dispatch<React.SetStateAction<Record<string, unknown>>> = update => {
        input = typeof update === 'function' ? update(input) : update;
    };
    const screen = await renderScreen(<ReviewStartBody input={input}
        onChange={onChange} source={{ enabled: true, where: null, selectedIds: new Set(['claude']),
            sections: [{ category: 'engine', section: { kind: 'static', id: 'engines', options: [
                { id: 'claude', label: 'Claude', onSelect: () => undefined },
            ] } }] }} choices={[{ targetKey: 'claude', backendId: 'claude', reviewEngineId: 'claude', agentId: 'claude',
                backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                title: 'Claude', disabled: false }]}
        transcriptAvailable={false} walkthrough={false} disabled={false} />);
    await screen.pressByTestIdAsync(`review-start-reviewer:${reviewReviewerIdForSelectionV1(1)}`);
    expect(input.reviewers).toEqual([first, person]);
    await screen.unmount();
});
it('authors a second step without replacing the first roster', async () => {
    let input: Record<string, unknown> = { reviewers: [{ kind: 'engine', engineId: 'claude' }] };
    const onChange: React.Dispatch<React.SetStateAction<Record<string, unknown>>> = update => {
        input = typeof update === 'function' ? update(input) : update;
    };
    const screen = await renderScreen(<ReviewStartBody input={input}
        onChange={onChange} source={{ enabled: true, sections: [], selectedIds: new Set(), where: null }}
        choices={[]} transcriptAvailable={false} walkthrough={false} disabled={false} />);
    await screen.pressByTestIdAsync('review-start-add-step');
    expect(input.steps).toEqual([
        { kind: 'review', reviewers: [{ kind: 'engine', engineId: 'claude' }], instructions: '' },
        { kind: 'verify', reviewers: [], instructions: '' },
    ]);
    await screen.unmount();
});
it('shows the walkthrough decision supplied by the comparison owner', async () => {
    let input: Record<string, unknown> = { reviewers: [{ kind: 'engine', engineId: 'claude' }] };
    const onChange: React.Dispatch<React.SetStateAction<Record<string, unknown>>> = update => {
        input = typeof update === 'function' ? update(input) : update;
    };
    const screen = await renderScreen(<ReviewStartBody {...{ walkthrough: true }}
        input={input}
        onChange={onChange} source={{ enabled: true, sections: [], selectedIds: new Set(), where: null }}
        choices={[]} transcriptAvailable={false} disabled={false} />);
    await screen.pressByTestIdAsync('review-start-walkthrough');
    expect(input.outputs).toEqual([]);
    await screen.unmount();
});
it('asks what to review first and records the chosen change area in the draft', async () => {
    let input: Record<string, unknown> = { changeType: 'uncommitted', reviewers: [{ kind: 'engine', engineId: 'claude' }] };
    const onChange: React.Dispatch<React.SetStateAction<Record<string, unknown>>> = update => {
        input = typeof update === 'function' ? update(input) : update;
    };
    const screen = await renderScreen(<ReviewStartBody input={input}
        onChange={onChange} source={{ enabled: true, sections: [], selectedIds: new Set(), where: null }}
        subject={{ options: ['committed', 'uncommitted', 'all'] }}
        choices={[]} transcriptAvailable={false} walkthrough={false} disabled={false} />);
    const order = screen.root.findAll(node => typeof node.props.testID === 'string'
        && ['review-start-subject', 'review-start-steps'].includes(node.props.testID) && typeof node.type === 'string')
        .map(node => node.props.testID);
    expect(order[0]).toBe('review-start-subject');
    await screen.pressByTestIdAsync('review-start-subject:all');
    expect(input.changeType).toBe('all');
    await screen.unmount();
});
it('reviews the staged index when selected, then replaces its source when the person chooses pending, all or a branch', async () => {
    let input: Record<string, unknown> = { changeType: 'uncommitted', instructions: 'Review the staged QA fixture',
        sessionId: 'qa-p03-session', reviewers: [{ kind: 'engine', engineId: 'claude' }] };
    const props = () => ({ input,
        onChange: ((update) => { input = typeof update === 'function' ? update(input) : update; }) satisfies React.Dispatch<React.SetStateAction<Record<string, unknown>>>,
        source: { enabled: true, sections: [], selectedIds: new Set<string>(), where: null },
        subject: { options: ['committed', 'uncommitted', 'all'] as const,
            branch: { head: 'main', defaultBase: 'origin/main', renderBase: () => null } },
        choices: [], transcriptAvailable: false, walkthrough: false, disabled: false });
    const screen = await renderScreen(<ReviewStartBody {...props()} />);
    for (const next of ['uncommitted', 'all', 'branch'] as const) {
        await screen.pressByTestIdAsync('review-start-subject:committed');
        const admitted = ReviewStartInputSchema.parse(input);
        expect(ScmComparisonSourceSchema.parse(admitted.source)).toEqual({ kind: 'workingTree', area: 'included' });
        expect(admitted.changeType).toBe('uncommitted');
        await screen.update(<ReviewStartBody {...props()} />);
        expect(screen.findByTestId('review-start-subject:committed')?.props.accessibilityState).toMatchObject({ selected: true });
        await screen.pressByTestIdAsync(`review-start-subject:${next}`);
        expect(input.source).toBeUndefined();
        expect(input.changeType).toBe(next === 'branch' ? 'committed' : next);
        await screen.update(<ReviewStartBody {...props()} />);
    }
    await screen.unmount();
});
// U8 R2 SB2: a branch is one of the things to review, compared with a base the person picks from the branch list.
it('reviews a branch against the base chosen beside it, and a change area drops that base', async () => {
    let input: Record<string, unknown> = { changeType: 'uncommitted', reviewers: [{ kind: 'engine', engineId: 'claude' }] };
    const onChange: React.Dispatch<React.SetStateAction<Record<string, unknown>>> = update => {
        input = typeof update === 'function' ? update(input) : update;
    };
    let chooseBase: ((branch: string) => void) | null = null;
    const props = () => ({ input, onChange, source: { enabled: true, sections: [], selectedIds: new Set<string>(), where: null },
        subject: { options: ['committed', 'uncommitted', 'all'] as const, branch: { head: 'fix/reconnect-backoff', defaultBase: 'main',
            renderBase: (base: string | null, change: (branch: string) => void) => { chooseBase = change; return null; } } },
        choices: [], transcriptAvailable: false, walkthrough: false, disabled: false });
    const screen = await renderScreen(<ReviewStartBody {...props()} />);
    await screen.pressByTestIdAsync('review-start-subject:branch');
    expect(input).toMatchObject({ changeType: 'committed', base: { kind: 'branch', baseBranch: 'main' } });
    await screen.update(<ReviewStartBody {...props()} />);
    expect(chooseBase).not.toBeNull();
    chooseBase!('release/0.3');
    expect(input.base).toEqual({ kind: 'branch', baseBranch: 'release/0.3' });
    await screen.pressByTestIdAsync('review-start-subject:uncommitted');
    expect(input).toMatchObject({ changeType: 'uncommitted', base: { kind: 'none' } });
    await screen.unmount();
});
