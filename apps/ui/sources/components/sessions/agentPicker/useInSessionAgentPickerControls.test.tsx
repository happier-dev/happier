import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { t } from '@/text';

import { useInSessionAgentPickerControls } from './useInSessionAgentPickerControls';
import type {
    SessionAgentContinuationMachineTarget,
    SessionAgentContinuationSourceState,
} from './resolveSessionAgentContinuationEligibility';

const announceAccessibilityMessage = vi.hoisted(() => vi.fn());
const machineRpcWithServerScope = vi.hoisted(() => vi.fn());

vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage,
}));

// The socket transport is the genuine system boundary here. It is stubbed
// outright rather than merged with the original, so a pure hook test never
// drags the live socket/encryption graph in behind it.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScope(params),
}));

// The seam to New Session's detail tree, not internal picker logic: the hook's
// contract here is what it does with a selection change, and this captures that
// callback without mounting another screen's model/config composition.
const detailSelectionChangeRef = vi.hoisted(() => ({
    current: null as null | ((next: unknown) => void),
}));

vi.mock('./buildSessionAgentPickerDetailContent', () => ({
    buildSessionAgentPickerDetailContent: (params: { onSelectionChange: (next: unknown) => void }) => {
        detailSelectionChangeRef.current = params.onSelectionChange;
        return null;
    },
}));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

vi.mock('@/agents/registry/registryUi', () => ({
    getAgentPickerIconScale: () => 1,
}));

function entry(
    agentId: string,
    overrides: Partial<ResolvedBackendCatalogEntry> = {},
): ResolvedBackendCatalogEntry {
    return {
        target: { kind: 'builtInAgent', agentId } as ResolvedBackendCatalogEntry['target'],
        targetKey: `builtInAgent:${agentId}`,
        family: 'builtInAgent',
        providerAgentId: agentId as ResolvedBackendCatalogEntry['providerAgentId'],
        builtInAgentId: agentId as ResolvedBackendCatalogEntry['builtInAgentId'],
        iconAgentId: agentId as ResolvedBackendCatalogEntry['iconAgentId'],
        title: agentId === 'claude' ? 'Claude Code' : agentId,
        subtitle: null,
        ...overrides,
    };
}

const CURRENT_AGENT_ROW: AgentInputChipPickerOption = {
    id: 'engine:claude',
    label: 'Claude Code',
    renderDetailContent: () => null,
};

const supportedSource: SessionAgentContinuationSourceState = {
    currentBackendTargetKey: 'builtInAgent:claude',
    storageKind: 'persisted',
    canEditSession: true,
    machinePresence: 'online',
};

const detailContext = {
    settings: {} as never,
    capabilityServerId: 'server-1',
    machineId: 'machine-1',
    cwd: '/repo',
};

const onlineMachine: SessionAgentContinuationMachineTarget = {
    machineId: 'machine-1',
    serverId: 'server-1',
    connectionGeneration: 1,
};

const AVAILABLE = {
    type: 'available',
    protocolVersion: 1,
    sameSessionTransition: true,
    nativeReturn: false,
} as const;

type HookProps = Readonly<{
    sessionId?: string;
    entries?: readonly ResolvedBackendCatalogEntry[];
    source?: SessionAgentContinuationSourceState;
    machine?: SessionAgentContinuationMachineTarget;
    featureEnabled?: boolean;
}>;

async function renderControls(props: HookProps = {}) {
    return renderHook((hookProps: HookProps) => useInSessionAgentPickerControls({
        sessionId: hookProps.sessionId ?? 'session-1',
        currentAgentId: 'claude',
        currentAgentLabel: 'Claude Code',
        entries: hookProps.entries ?? [entry('claude'), entry('codex')],
        featureEnabled: hookProps.featureEnabled ?? true,
        source: hookProps.source ?? supportedSource,
        machine: hookProps.machine ?? onlineMachine,
        detail: detailContext,
    }), { initialProps: props });
}

function optionsOf(controls: ReturnType<typeof useInSessionAgentPickerControls>) {
    return controls.composeAgentPickerOptions([CURRENT_AGENT_ROW]);
}

/** Open the composer's Agent picker and let its inspections settle. */
async function openPicker(hook: Awaited<ReturnType<typeof renderControls>>) {
    await act(async () => {
        hook.getCurrent().onAgentPickerVisibilityChange(true);
    });
    await act(async () => {
        await Promise.resolve();
    });
}

describe('useInSessionAgentPickerControls', () => {
    beforeEach(() => {
        announceAccessibilityMessage.mockClear();
        machineRpcWithServerScope.mockReset();
        machineRpcWithServerScope.mockResolvedValue(AVAILABLE);
    });

    it('offers the rest of the Agent catalog beside the Agent already running', async () => {
        const hook = await renderControls();
        await openPicker(hook);

        expect(optionsOf(hook.getCurrent()).map((option) => option.id)).toEqual([
            'engine:claude',
            'builtInAgent:codex',
        ]);
        // The running Agent's row carries no second line: its checkmark says it, and
        // a checkmark is not an accessible state, so the fact lives in the name.
        expect(optionsOf(hook.getCurrent())[0]?.subtitle).toBeUndefined();
        expect(optionsOf(hook.getCurrent())[0]?.accessibilityLabel)
            .toBe(t('session.agentContinuation.currentAgentAccessibilityLabel', { agent: 'Claude Code' }));
    });

    it('leaves the composer untouched when this Session has no other Agent to offer', async () => {
        const hook = await renderControls({ entries: [entry('claude')] });

        expect(optionsOf(hook.getCurrent())).toEqual([CURRENT_AGENT_ROW]);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('has the answer before the popover is ever opened, so it opens decided', async () => {
        // Asking when the popover opens is too late: the machine round trip and the
        // popover's own mount take about the same time, so the popover would open
        // at one width and grow by the width of the rail when the answers land.
        const hook = await renderControls();
        await act(async () => { await Promise.resolve(); });

        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);

        // Opening it now changes nothing: the decision was already made.
        await act(async () => {
            hook.getCurrent().onAgentPickerVisibilityChange(true);
        });
        expect(optionsOf(hook.getCurrent()).map((option) => option.id)).toEqual([
            'engine:claude',
            'builtInAgent:codex',
        ]);
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);
    });

    it('asks nothing at all for a Session whose picker could never offer a switch', async () => {
        // The cost of asking early is bounded by never asking where the answer
        // cannot matter: a closed gate, a Session that cannot be written to or whose
        // transcript is its Agent's own, and a Session with no other Agent.
        for (const props of [
            { featureEnabled: false },
            { source: { ...supportedSource, canEditSession: false } },
            { source: { ...supportedSource, storageKind: 'direct' as const } },
            { entries: [entry('claude')] },
        ]) {
            machineRpcWithServerScope.mockClear();
            const hook = await renderControls(props);
            await act(async () => { await Promise.resolve(); });
            await act(async () => {
                hook.getCurrent().onAgentPickerVisibilityChange(true);
            });

            expect(machineRpcWithServerScope).not.toHaveBeenCalled();
            expect(optionsOf(hook.getCurrent())).toEqual([CURRENT_AGENT_ROW]);
        }
    });

    it('holds a target still being asked about in the restrained pending treatment', async () => {
        // A live rail can still contain an unanswered row when its siblings have
        // already answered. That row is disabled and says it is being checked; it
        // never claims a refusal it has not been given.
        machineRpcWithServerScope.mockImplementation((params: { payload: { selection: { agentId: string } } }) => (
            params.payload.selection.agentId === 'codex'
                ? Promise.resolve(AVAILABLE)
                : new Promise(() => {})
        ));
        const hook = await renderControls({ entries: [entry('claude'), entry('codex'), entry('gemini')] });
        await openPicker(hook);

        const geminiOption = optionsOf(hook.getCurrent())
            .find((option) => option.id === 'builtInAgent:gemini');
        expect(geminiOption).toMatchObject({
            disabled: true,
            subtitle: t('session.agentContinuation.checking'),
        });
        expect(geminiOption?.onApply).toBeUndefined();
    });

    it('makes an eligible Agent armable once its machine reports live support', async () => {
        const hook = await renderControls();
        await openPicker(hook);

        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: 'session.continuation.inspect',
            payload: { v: 1, sourceSessionId: 'session-1', selection: { v: 1, agentId: 'codex' } },
        }));

        const [, codexOption] = optionsOf(hook.getCurrent());
        expect(codexOption?.disabled).toBe(false);
        // Commit-on-select, like every sibling model picker: no confirm affordance.
        expect(codexOption?.onSelectImmediate).toBeTypeOf('function');
        expect(codexOption?.onApply).toBeUndefined();
        expect(codexOption?.applyLabel).toBeUndefined();
        // Choosing the Agent must not close the popover, or picking its model
        // would become a second trip.
        expect(codexOption?.closeOnSelectImmediate).toBe(false);
    });

    it('gives a target Agent its own model detail instead of prose above an empty pane', async () => {
        // Engine and model are one decision: choosing Codex must show Codex's own
        // models, the way New Session shows them, not a paragraph about switching.
        const hook = await renderControls();
        await openPicker(hook);

        const [, codexOption] = optionsOf(hook.getCurrent());
        expect(codexOption?.renderDetailContent).toBeTypeOf('function');
        expect(codexOption?.deferredDetailContentCacheKey)
            .toBe('session-continuation-engine:builtInAgent:codex');
        // The continuation meaning is one line in the model section's subtitle slot,
        // never a standalone description block.
        expect(codexOption?.detailDescription).toBeUndefined();
    });

    it('arms nothing until a row is deliberately selected', async () => {
        const hook = await renderControls();
        await openPicker(hook);
        const [, codexOption] = optionsOf(hook.getCurrent());

        // Selection commits, so the guarantee that matters is that merely opening the
        // picker and building its rows commits nothing. `onSelectImmediate` is called
        // by the panel on deliberate activation — tap, click, Enter, Space — and never
        // on hover or pointer travel, so offering it is not itself an effect.
        expect(codexOption?.onSelectImmediate).toBeTypeOf('function');
        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(hook.getCurrent().armedContinuationLocalId).toBeNull();
        expect(announceAccessibilityMessage).not.toHaveBeenCalled();
    });

    it('arms the next message on selection, and announces that nothing was sent', async () => {
        const hook = await renderControls();
        await openPicker(hook);

        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.onSelectImmediate?.();
        });

        expect(hook.getCurrent().armedContinuation).toEqual({
            v: 1,
            mode: 'same_session',
            sourceAgentId: 'claude',
            selection: { v: 1, agentId: 'codex' },
        });
        expect(hook.getCurrent().agentPickerSelectedOptionId).toBe('builtInAgent:codex');
        // The submission identity belongs to the armed choice and survives
        // re-renders, so retrying the same armed switch after an unknown outcome
        // re-admits ONE message rather than sending a second copy.
        const armedLocalId = hook.getCurrent().armedContinuationLocalId;
        expect(armedLocalId).toEqual(expect.any(String));
        await hook.rerender({});
        expect(hook.getCurrent().armedContinuationLocalId).toBe(armedLocalId);
        expect(announceAccessibilityMessage).toHaveBeenCalledTimes(1);
        expect(announceAccessibilityMessage).toHaveBeenCalledWith(
            t('session.agentContinuation.announcement', { agent: 'codex' }),
        );
    });

    it('moves the checkmark to the armed row while the running row keeps its name', async () => {
        const hook = await renderControls();
        await openPicker(hook);

        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.onSelectImmediate?.();
        });

        const [currentOption] = optionsOf(hook.getCurrent());
        // One checkmark, on the selection, as in every sibling model picker. What is
        // armed is named by the send button at the moment of consequence, so the rail
        // carries no second marker — but the running row still says what it is in
        // words, because a checkmark it no longer has was never an accessible state.
        expect(hook.getCurrent().agentPickerSelectedOptionId).toBe('builtInAgent:codex');
        expect(currentOption?.accessibilityLabel).toBe(
            t('session.agentContinuation.currentAgentAccessibilityLabel', { agent: 'Claude Code' }),
        );
    });

    it('re-arms when the model changes, without re-announcing on every model tap', async () => {
        const hook = await renderControls();
        await openPicker(hook);

        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.onSelectImmediate?.();
        });
        const firstLocalId = hook.getCurrent().armedContinuationLocalId;
        expect(announceAccessibilityMessage).toHaveBeenCalledTimes(1);

        // Choosing a model IS part of the same choice, so it must reach the armed
        // intent rather than waiting for a confirm step that no longer exists.
        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.renderDetailContent?.();
            detailSelectionChangeRef.current?.({
                modelId: 'opus-5',
                modelSelection: null,
                sessionModeId: null,
                configOverrides: {},
            });
        });

        expect(hook.getCurrent().armedContinuation?.selection).toMatchObject({ modelId: 'opus-5' });
        // A different switch gets a different submission identity.
        expect(hook.getCurrent().armedContinuationLocalId).not.toBe(firstLocalId);
        // The model row's own selected state is the feedback; announcing again would nag.
        expect(announceAccessibilityMessage).toHaveBeenCalledTimes(1);
    });

    it('names the armed row for screen readers instead of wrapping a subtitle under it', async () => {
        const hook = await renderControls();
        await openPicker(hook);

        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.onSelectImmediate?.();
        });

        const codexOption = optionsOf(hook.getCurrent())[1];
        // The same ruling that removed the running row's subtitle applies here: a
        // second line in a 190 px rail wraps and breaks the row rhythm. The
        // checkmark carries it visually; the accessible name carries the words.
        expect(codexOption?.subtitle).toBeUndefined();
        expect(codexOption?.accessibilityLabel).toBe(
            t('session.agentContinuation.armedAccessibilityLabel', { agent: 'codex' }),
        );
    });

    it('returns to the running Agent by selecting it, with no separate confirm button', async () => {
        const hook = await renderControls();
        await openPicker(hook);

        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.onSelectImmediate?.();
        });

        const [currentOption] = optionsOf(hook.getCurrent());
        expect(currentOption?.detailActionLabel).toBeUndefined();
        expect(currentOption?.onDetailAction).toBeUndefined();

        await act(async () => {
            currentOption?.onSelectImmediate?.();
        });

        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(hook.getCurrent().agentPickerSelectedOptionId).toBeNull();
        expect(optionsOf(hook.getCurrent())[0]?.detailActionLabel).toBeUndefined();
    });

    it('shows no Agent rail at all while the server has not enabled Agent switching', async () => {
        // `sessions.agentSwitching` is server-represented and fails closed. A rail
        // rendered against a missing or disabled bit would offer — and announce —
        // a switch this deployment will refuse.
        const hook = await renderControls({ featureEnabled: false });
        await openPicker(hook);

        expect(optionsOf(hook.getCurrent())).toEqual([CURRENT_AGENT_ROW]);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        expect(hook.getCurrent().armedContinuation).toBeNull();
    });

    it('drops an armed choice the moment the gate closes underneath it', async () => {
        const hook = await renderControls();
        await openPicker(hook);

        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.onSelectImmediate?.();
        });
        expect(hook.getCurrent().armedContinuation).not.toBeNull();

        await hook.rerender({ featureEnabled: false });

        // The submit path reads exactly this value, so a stale arm surviving a
        // closing gate is the whole gate bypassed.
        expect(hook.getCurrent().armedContinuation).toBeNull();
    });

    it('drops an armed choice that no longer belongs to the Session it was made in', async () => {
        const hook = await renderControls();
        await openPicker(hook);

        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.onSelectImmediate?.();
        });
        expect(hook.getCurrent().armedContinuation).not.toBeNull();

        await hook.rerender({ sessionId: 'session-2' });

        expect(hook.getCurrent().armedContinuation).toBeNull();
    });

    it('drops an armed choice when the running Agent changes underneath the composer', async () => {
        const hook = await renderControls();
        await openPicker(hook);

        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.onSelectImmediate?.();
        });

        await hook.rerender({
            source: { ...supportedSource, currentBackendTargetKey: 'builtInAgent:gemini' },
        });

        expect(hook.getCurrent().armedContinuation).toBeNull();
    });

    it('drops an armed choice the Agent catalog no longer offers', async () => {
        const hook = await renderControls();
        await openPicker(hook);

        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.onSelectImmediate?.();
        });
        expect(hook.getCurrent().agentPickerSelectedOptionId).toBe('builtInAgent:codex');

        await hook.rerender({ entries: [entry('claude'), entry('gemini')] });

        expect(hook.getCurrent().agentPickerSelectedOptionId).toBeNull();
    });

    it('drops an armed choice once the rail that could cancel it is gone', async () => {
        // Selection IS arming and there is no confirm step, so re-selecting the
        // running Agent's row is the only cancel gesture. That row only carries it
        // while the rail is offered — `composeAgentPickerOptions` returns the
        // composer's own rows untouched otherwise — so an arm that outlives the
        // rail is an arm with no way out: every ordinary send is re-routed into a
        // transition the machine will refuse, the refusal keeps the arm, and the
        // reader's only escape is to leave the Session.
        const hook = await renderControls();
        await openPicker(hook);

        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.onSelectImmediate?.();
        });
        expect(hook.getCurrent().armedContinuation).not.toBeNull();

        // Exactly what SessionView passes when the Session's machine drops:
        // `isMachineOnline(...)` goes false and every target becomes unavailable.
        await hook.rerender({ source: { ...supportedSource, machinePresence: 'offline' } });

        // The open popover keeps the shape it opened with, so the cancel gesture is
        // still on screen and the arm is still reachable — the invariant is that an
        // arm never outlives its way out, not that it dies the instant its target
        // does.
        expect(optionsOf(hook.getCurrent())[0]?.onSelectImmediate).toBeTypeOf('function');
        expect(hook.getCurrent().armedContinuation).not.toBeNull();

        // Closing it is where the rail decision is taken again, and the arm goes
        // with the rail.
        await act(async () => {
            hook.getCurrent().onAgentPickerVisibilityChange(false);
        });

        expect(optionsOf(hook.getCurrent())).toEqual([CURRENT_AGENT_ROW]);
        expect(hook.getCurrent().armedContinuation).toBeNull();
        // The submit path reads the identity too; a surviving localId would keep
        // naming a switch that no longer exists.
        expect(hook.getCurrent().armedContinuationLocalId).toBeNull();
    });

    it('keeps an armed choice while the rail \u2014 and therefore the cancel gesture \u2014 is still there', async () => {
        // The control for the rule above: the arm is bounded by the CANCEL GESTURE's
        // reachability, not by its own target's eligibility. One blocked target
        // inside a live rail keeps that gesture on screen, so the arm survives and
        // the reader can still take it back.
        const hook = await renderControls({
            entries: [entry('claude'), entry('codex'), entry('gemini')],
        });
        await openPicker(hook);

        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.onSelectImmediate?.();
        });
        expect(hook.getCurrent().armedContinuation).not.toBeNull();

        await hook.rerender({
            entries: [
                entry('claude'),
                entry('codex', { family: 'configuredAcpBackend' }),
                entry('gemini'),
            ],
        });

        expect(hook.getCurrent().armedContinuation).not.toBeNull();
        await act(async () => {
            optionsOf(hook.getCurrent())[0]?.onSelectImmediate?.();
        });
        expect(hook.getCurrent().armedContinuation).toBeNull();
    });

    it('reuses one answer per target for as long as the connection lasts', async () => {
        const hook = await renderControls();
        await openPicker(hook);
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);

        await act(async () => {
            hook.getCurrent().onAgentPickerVisibilityChange(false);
        });
        await openPicker(hook);

        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);
    });

    it('re-inspects after a reconnect instead of trusting the previous connection', async () => {
        const hook = await renderControls();
        await openPicker(hook);
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);

        await hook.rerender({ machine: { ...onlineMachine, connectionGeneration: 2 } });
        await act(async () => {
            await Promise.resolve();
        });

        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(2);
    });

    it('never calls a machine it already knows is offline, and offers no rail', async () => {
        const hook = await renderControls({
            entries: [entry('claude'), entry('codex'), entry('gemini')],
            source: { ...supportedSource, machinePresence: 'offline' },
        });
        await openPicker(hook);

        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        // Nothing here can be chosen, so the composer keeps its existing model
        // picker and shows no Agent rail — not a rail of dead rows repeating one
        // fact about the machine.
        expect(optionsOf(hook.getCurrent())).toEqual([CURRENT_AGENT_ROW]);
    });

    it('drops the rail once every Agent in it has been refused, and arms nothing', async () => {
        machineRpcWithServerScope.mockRejectedValue(Object.assign(
            new Error('RPC method not available'),
            { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' },
        ));
        const hook = await renderControls({
            entries: [entry('claude'), entry('codex'), entry('gemini')],
        });

        // An unanswered question is not a choice, so a rail is never offered on the
        // strength of one — not before the picker is opened, and not while it waits.
        expect(optionsOf(hook.getCurrent())).toEqual([CURRENT_AGENT_ROW]);

        await openPicker(hook);

        expect(optionsOf(hook.getCurrent())).toEqual([CURRENT_AGENT_ROW]);
        expect(hook.getCurrent().armedContinuation).toBeNull();
    });

    it('never takes the rail away while the popover the reader opened is still open', async () => {
        // The reported defect. The rail appeared on the strength of questions still
        // in flight, then vanished about half a second later when the machine
        // refused every one of them — the popover changing shape under the reader.
        const answers: Array<(value: unknown) => void> = [];
        machineRpcWithServerScope.mockImplementation(() => new Promise((resolve) => {
            answers.push(resolve);
        }));
        const hook = await renderControls({
            entries: [entry('claude'), entry('codex'), entry('gemini')],
        });

        await act(async () => {
            hook.getCurrent().onAgentPickerVisibilityChange(true);
        });
        await act(async () => { await Promise.resolve(); });

        // Opened with nothing proven switchable: no rail.
        const whileWaiting = optionsOf(hook.getCurrent()).map((option) => option.id);
        expect(whileWaiting).toEqual(['engine:claude']);

        await act(async () => {
            for (const resolve of answers) resolve({ type: 'unavailable', reason: 'unsupported_session' });
            await Promise.resolve();
        });
        await act(async () => { await Promise.resolve(); });

        // …and the answers cannot change what this open popover already is.
        expect(optionsOf(hook.getCurrent()).map((option) => option.id)).toEqual(whileWaiting);
    });

    it('holds a rail it has already shown for the rest of that open popover', async () => {
        const hook = await renderControls({ entries: [entry('claude'), entry('codex')] });
        await openPicker(hook);
        expect(optionsOf(hook.getCurrent()).map((option) => option.id)).toEqual([
            'engine:claude',
            'builtInAgent:codex',
        ]);

        // A reconnect discards every answer read over the previous connection, so
        // the rows go back to being unanswered. That must not empty a rail the
        // reader is looking at.
        machineRpcWithServerScope.mockImplementation(() => new Promise(() => {}));
        await hook.rerender({ machine: { ...onlineMachine, connectionGeneration: 2 } });
        await act(async () => { await Promise.resolve(); });

        expect(optionsOf(hook.getCurrent()).map((option) => option.id)).toEqual([
            'engine:claude',
            'builtInAgent:codex',
        ]);
    });

    it('decides before the popover paints when the answers are already cached', async () => {
        // Second open on the same connection: the answers are held, so the rail
        // decision is available in the first render of the reopened popover rather
        // than arriving after it.
        const hook = await renderControls({ entries: [entry('claude'), entry('codex')] });
        await openPicker(hook);
        await act(async () => {
            hook.getCurrent().onAgentPickerVisibilityChange(false);
        });

        await act(async () => {
            hook.getCurrent().onAgentPickerVisibilityChange(true);
        });
        expect(optionsOf(hook.getCurrent()).map((option) => option.id)).toEqual([
            'engine:claude',
            'builtInAgent:codex',
        ]);
    });

    it('does not blame the CLI when the call simply failed to complete', async () => {
        // A timeout proves nothing about the daemon. Saying "update the CLI" here
        // would be a false instruction on a perfectly current machine — and with no
        // Agent left to choose, the picker says nothing at all instead.
        machineRpcWithServerScope.mockRejectedValue(new Error('Machine RPC timed out after 30000ms'));
        const hook = await renderControls({
            entries: [entry('claude'), entry('codex'), entry('gemini')],
        });
        await openPicker(hook);

        const options = optionsOf(hook.getCurrent());
        expect(options).toEqual([CURRENT_AGENT_ROW]);
        expect(options.some((option) => (
            option.subtitle === t('session.agentContinuation.unavailable.updateCli')
        ))).toBe(false);
    });

    it('keeps an ordinary hosted Session switchable', async () => {
        // The reported defect: this resolved as unswitchable for every Session,
        // because the row read an Agent capability instead of this Session's own
        // storage kind. A hosted Session must still be offered its other Agents.
        const hook = await renderControls({
            entries: [entry('claude'), entry('codex')],
            source: { ...supportedSource, storageKind: 'persisted' },
        });
        await openPicker(hook);

        const [, codexOption] = optionsOf(hook.getCurrent());
        expect(codexOption?.disabled).toBe(false);
        expect(codexOption?.onSelectImmediate).toBeTypeOf('function');
    });

    it('shows no Agent rail at all when nothing in this Session can be switched to', async () => {
        const hook = await renderControls({
            entries: [entry('claude'), entry('codex'), entry('gemini')],
            source: { ...supportedSource, storageKind: 'direct' },
        });
        await openPicker(hook);

        expect(optionsOf(hook.getCurrent())).toEqual([CURRENT_AGENT_ROW]);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });
});
