import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createResolvedAgentCatalogEntryFixture } from '@/dev/testkit';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import {
    readSessionDraftValue,
    resetSessionDraftValueCachesForTests,
} from '@/dev/testkit/sessionDraftRepositoryTestkit';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { deleteRawSessionDraftValues } from '@/sync/domains/state/sessionDraftValuesPersistence';
import { t } from '@/text';

import {
    useInSessionAgentPickerControls,
    type SessionAgentContinuationFeatureDecision,
} from './useInSessionAgentPickerControls';
import type {
    SessionAgentContinuationMachineTarget,
    SessionAgentContinuationSourceState,
} from './resolveSessionAgentContinuationEligibility';

const announceAccessibilityMessage = vi.hoisted(() => vi.fn());

// The host's pointer capability is a platform boundary, and it decides WHEN this
// hook asks its machine anything. Held here so both answers can be exercised.
const hoverCapablePrimaryPointer = vi.hoisted(() => ({ current: false }));
vi.mock('@/utils/platform/webMobileHeuristics', () => ({
    isHoverCapablePrimaryPointer: () => hoverCapablePrimaryPointer.current,
}));
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
const detailModelSummaryRef = vi.hoisted(() => ({ current: null as string | null | undefined }));

vi.mock('./buildSessionAgentPickerDetailContent', () => ({
    buildSessionAgentPickerDetailContent: (params: {
        onSelectionChange: (next: unknown) => void;
        modelSummary?: string;
    }) => {
        detailSelectionChangeRef.current = params.onSelectionChange;
        detailModelSummaryRef.current = params.modelSummary;
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
    backendId: string,
    overrides: Partial<ResolvedBackendCatalogEntry> = {},
): ResolvedBackendCatalogEntry {
    return {
        agentCatalogEntry: createResolvedAgentCatalogEntryFixture({ agentId: backendId }),
        backendTarget: { kind: 'backend', backendId },
        backendTargetKey: `backend:${backendId}`,
        kind: 'builtInAgent',
        backendId,
        agentId: backendId,
        catalogAgentId: backendId as ResolvedBackendCatalogEntry['catalogAgentId'],
        builtInAgentId: backendId as ResolvedBackendCatalogEntry['builtInAgentId'],
        iconAgentId: backendId as ResolvedBackendCatalogEntry['iconAgentId'],
        title: backendId === 'claude' ? 'Claude Code' : backendId,
        subtitle: null,
        cliAuthBackgroundCheckSafe: false,
        ...overrides,
    };
}

const CURRENT_AGENT_ROW: AgentInputChipPickerOption = {
    id: 'engine:claude',
    label: 'Claude Code',
    renderDetailContent: () => null,
};

const supportedSource: SessionAgentContinuationSourceState = {
    currentBackendTargetKey: 'backend:claude',
    storageKind: 'persisted',
    canEditSession: true,
    machinePresence: 'online',
    hasConversationToCarry: true,
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
    daemonGeneration: 1,
};

const AVAILABLE = {
    type: 'available',
    protocolVersion: 1,
    sameSessionTransition: true,
} as const;

type HookProps = Readonly<{
    sessionId?: string;
    accountScope?: ServerAccountScope | null;
    entries?: readonly ResolvedBackendCatalogEntry[];
    source?: SessionAgentContinuationSourceState;
    machine?: SessionAgentContinuationMachineTarget;
    featureDecision?: SessionAgentContinuationFeatureDecision;
    sessionActive?: boolean | null;
}>;

async function renderControls(props: HookProps = {}) {
    return renderHook((hookProps: HookProps) => useInSessionAgentPickerControls({
        sessionId: hookProps.sessionId ?? 'session-1',
        accountScope: hookProps.accountScope ?? null,
        currentAgentId: 'claude',
        currentAgentLabel: 'Claude Code',
        currentAgentSessionActive: hookProps.sessionActive ?? true,
        entries: hookProps.entries ?? [entry('claude'), entry('codex')],
        featureDecision: hookProps.featureDecision === undefined
            ? { state: 'enabled' }
            : hookProps.featureDecision,
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
        // The armed choice is a Session draft value now, so each case starts from
        // an empty draft rather than inheriting the previous one's arm.
        resetSessionDraftValueCachesForTests();
        deleteRawSessionDraftValues(null);
        announceAccessibilityMessage.mockClear();
        machineRpcWithServerScope.mockReset();
        machineRpcWithServerScope.mockResolvedValue(AVAILABLE);
        hoverCapablePrimaryPointer.current = false;
        detailSelectionChangeRef.current = null;
        detailModelSummaryRef.current = null;
    });

    it('offers the rest of the Agent catalog beside the Agent already running', async () => {
        const hook = await renderControls();
        await openPicker(hook);

        expect(optionsOf(hook.getCurrent()).map((option) => option.id)).toEqual([
            'engine:claude',
            'backend:codex',
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
        expect(optionsOf(hook.getCurrent()).map((option) => option.id))
            .toEqual(['engine:claude', 'backend:codex']);
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);
    });

    it('waits for the reader to reach for the chip when the pointer can say so first', async () => {
        // A pointer has to travel over the Agent chip to click it, so intent is a
        // real signal and Sessions the reader never approaches cost nothing.
        hoverCapablePrimaryPointer.current = true;
        const hook = await renderControls();
        await act(async () => { await Promise.resolve(); });

        expect(machineRpcWithServerScope).not.toHaveBeenCalled();

        await act(async () => {
            hook.getCurrent().onAgentPickerIntent();
        });
        await act(async () => { await Promise.resolve(); });

        // Asked on approach, and the rail is decided before the popover is opened.
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);
        await act(async () => {
            hook.getCurrent().onAgentPickerVisibilityChange(true);
        });
        expect(optionsOf(hook.getCurrent()).length).toBeGreaterThan(1);
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);
    });

    it('marks the running Agent once the selection has moved, and never before', async () => {
        const hook = await renderControls({ sessionActive: true });
        await openPicker(hook);

        // Nothing is competing with the selection yet, so the row is simply the
        // selection and carries only its checkmark.
        expect(optionsOf(hook.getCurrent())[0]?.statusMarker).toBeUndefined();

        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.onSelectImmediate?.();
        });

        // The checkmark has travelled, so the running row takes the marker the model
        // list already draws beside this Session's applied model.
        const [currentOption] = optionsOf(hook.getCurrent());
        expect(currentOption?.statusMarker).toBeTruthy();
        expect((currentOption?.statusMarker as { props?: { status?: string } })?.props?.status)
            .toBe('running');
        // A glyph is not an accessible state, so the two rows are told apart in words.
        expect(currentOption?.accessibilityLabel).toBe(
            t('session.agentContinuation.currentAgentAccessibilityLabel', { agent: 'Claude Code' }),
        );
    });

    it('never claims the Agent is running when the Session is not', async () => {
        // The model list two columns away shows a clock for an inactive Session's
        // applied model. The Agent row reads from the same owner, so the popover
        // cannot say "running" on one side and "last used" on the other.
        const hook = await renderControls({ sessionActive: false });
        await openPicker(hook);
        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.onSelectImmediate?.();
        });

        const [currentOption] = optionsOf(hook.getCurrent());
        expect((currentOption?.statusMarker as { props?: { status?: string } })?.props?.status)
            .toBe('last_used');
        expect(currentOption?.accessibilityLabel).toBe(
            t('session.agentContinuation.currentAgentLastUsedAccessibilityLabel', { agent: 'Claude Code' }),
        );
    });

    it('asks nothing at all for a Session whose picker could never offer a switch', async () => {
        // The cost of asking early is bounded by never asking where the answer
        // cannot matter: a closed gate, a Session that cannot be written to or whose
        // transcript is its Agent's own, and a Session with no other Agent.
        for (const props of [
            { featureDecision: { state: 'disabled' as const } },
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
            .find((option) => option.id === 'backend:gemini');
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

    it('inspects and offers a session-capable installed Agent from the projected catalog', async () => {
        const installedAgent = entry('ultracode', {
            kind: 'pluginBackend',
            builtInAgentId: null,
            catalogAgentId: null,
            iconAgentId: null,
            capabilities: { session: { supported: true } } as ResolvedBackendCatalogEntry['capabilities'],
            title: 'UltraCode',
        });
        const hook = await renderControls({ entries: [entry('claude'), installedAgent] });
        await openPicker(hook);

        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            method: 'session.continuation.inspect',
            payload: { v: 1, sourceSessionId: 'session-1', selection: { v: 1, agentId: 'ultracode' } },
        }));
        expect(optionsOf(hook.getCurrent())).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'backend:ultracode', label: 'UltraCode', disabled: false }),
        ]));
    });

    it('gives a target Agent its own model detail instead of prose above an empty pane', async () => {
        // Engine and model are one decision: choosing Codex must show Codex's own
        // models, the way New Session shows them, not a paragraph about switching.
        const hook = await renderControls();
        await openPicker(hook);

        const [, codexOption] = optionsOf(hook.getCurrent());
        expect(codexOption?.renderDetailContent).toBeTypeOf('function');
        expect(codexOption?.deferredDetailContentCacheKey)
            .toBe('session-continuation-engine:backend:codex');
        // The continuation meaning is one line in the model section's subtitle slot,
        // never a standalone description block.
        expect(codexOption?.detailDescription).toBeUndefined();
    });

    // The in-session transition seeds the target through `resolveReplaySeedDraft`
    // with `recent_messages` plus a character cap, and the coordinator drops the
    // resolved `referencedSessionMediaWorkspacePaths` — no media-continuity
    // envelope is composed on this path at all. So the line must not promise the
    // whole conversation, and it must say that attachments are left behind.
    it('states what a switch actually carries, media limitation included', async () => {
        const hook = await renderControls();
        await openPicker(hook);

        optionsOf(hook.getCurrent())[1]?.renderDetailContent?.({ onRequestClose: () => {} });

        expect(detailModelSummaryRef.current).toBe(t('session.agentContinuation.detailDescription'));
        expect(detailModelSummaryRef.current).toContain('as text');
        expect(detailModelSummaryRef.current).toContain('images and files');
    });

    it('does not promise a carry-over on a Session with nothing to carry', async () => {
        // Same disclosure, one Session earlier: on an empty transcript there is
        // no conversation, so the sentence that reassures a reader mid-thread
        // states something the switch cannot do. Only the half that is still
        // true survives.
        const hook = await renderControls({
            source: { ...supportedSource, hasConversationToCarry: false },
        });
        await openPicker(hook);

        optionsOf(hook.getCurrent())[1]?.renderDetailContent?.({ onRequestClose: () => {} });

        expect(detailModelSummaryRef.current).toBe(t('session.agentContinuation.detailDescriptionEmpty'));
        expect(detailModelSummaryRef.current).not.toContain('carries over');
        expect(detailModelSummaryRef.current).toContain('Nothing is sent');
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
        expect(hook.getCurrent().agentPickerSelectedOptionId).toBe('backend:codex');
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
        expect(hook.getCurrent().agentPickerSelectedOptionId).toBe('backend:codex');
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
            optionsOf(hook.getCurrent())[1]?.renderDetailContent?.({ onRequestClose: () => {} });
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

    it('waits for inspection of the exact model, provider, mode and config before re-arming', async () => {
        const hook = await renderControls();
        await openPicker(hook);
        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.onSelectImmediate?.();
        });
        const firstLocalId = hook.getCurrent().armedContinuationLocalId;

        let resolveChangedSelection: ((value: unknown) => void) | null = null;
        machineRpcWithServerScope.mockClear();
        machineRpcWithServerScope.mockImplementation((params: {
            payload: { selection: Record<string, unknown> };
        }) => {
            expect(params.payload.selection).toMatchObject({
                v: 1,
                agentId: 'codex',
                modelId: 'opus-5',
                providerConnectionId: 'provider-1',
                acpSessionModeId: 'plan',
                sessionConfigOptionOverrides: {
                    overrides: { reasoning: { value: 'high' } },
                },
            });
            return new Promise((resolve) => { resolveChangedSelection = resolve; });
        });

        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.renderDetailContent?.({ onRequestClose: () => {} });
            detailSelectionChangeRef.current?.({
                modelId: 'opus-5',
                modelSelection: {
                    v: 1,
                    updatedAt: 7,
                    ref: {
                        agentTargetKey: 'backend:codex',
                        providerConnectionId: 'provider-1',
                        modelId: 'opus-5',
                    },
                },
                sessionModeId: 'plan',
                configOverrides: { reasoning: 'high' },
            });
            await Promise.resolve();
        });

        // The default-selection answer is not a proxy for this choice. While
        // the exact selection is unanswered, the old arm cannot redirect a send.
        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);

        await act(async () => {
            resolveChangedSelection?.(AVAILABLE);
            await Promise.resolve();
        });
        await act(async () => { await Promise.resolve(); });

        expect(hook.getCurrent().armedContinuation?.selection).toMatchObject({
            modelId: 'opus-5',
            providerConnectionId: 'provider-1',
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                overrides: { reasoning: { value: 'high' } },
            },
        });
        expect(hook.getCurrent().armedContinuationLocalId).not.toBe(firstLocalId);
    });

    it('keeps a Provider model literally named default as a real choice, not Automatic', async () => {
        const hook = await renderControls();
        await openPicker(hook);
        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.onSelectImmediate?.();
        });

        let resolveChangedSelection: ((value: unknown) => void) | null = null;
        machineRpcWithServerScope.mockClear();
        machineRpcWithServerScope.mockImplementation((params: {
            payload: { selection: Record<string, unknown> };
        }) => {
            // The strict transition schema requires a modelId whenever a
            // connection is set, so dropping `default` here makes the exact
            // inspection unparseable and the row unarmable.
            expect(params.payload.selection).toMatchObject({
                v: 1,
                agentId: 'codex',
                modelId: 'default',
                providerConnectionId: 'provider-1',
            });
            return new Promise((resolve) => { resolveChangedSelection = resolve; });
        });

        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.renderDetailContent?.({ onRequestClose: () => {} });
            detailSelectionChangeRef.current?.({
                modelId: 'default',
                modelLabel: 'Gateway default',
                modelSelection: {
                    v: 1,
                    updatedAt: 7,
                    ref: {
                        agentTargetKey: 'backend:codex',
                        providerConnectionId: 'provider-1',
                        modelId: 'default',
                    },
                },
                sessionModeId: null,
                configOverrides: {},
            });
            await Promise.resolve();
        });

        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);
        await act(async () => {
            resolveChangedSelection?.(AVAILABLE);
            await Promise.resolve();
        });
        await act(async () => { await Promise.resolve(); });

        expect(hook.getCurrent().armedContinuation?.selection).toMatchObject({
            modelId: 'default',
            providerConnectionId: 'provider-1',
        });
        expect(hook.getCurrent().armedContinuationModelLabel).toBe('Gateway default');
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
        const hook = await renderControls({ featureDecision: { state: 'disabled' } });
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

        await hook.rerender({ featureDecision: { state: 'disabled' } });
        await act(async () => { await Promise.resolve(); });

        // The submit path reads exactly this value, so a stale arm surviving a
        // closing gate is the whole gate bypassed.
        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(readSessionDraftValue(null, 'session-1', 'routing.agentContinuation')).toBeUndefined();

        // A definite disable is a destructive policy decision, not a temporary
        // presentation state: turning the bit back on must not resurrect an arm
        // formed under the old policy.
        await hook.rerender({ featureDecision: { state: 'enabled' } });
        expect(hook.getCurrent().armedContinuation).toBeNull();
    });

    it('fails closed while feature state is unresolved without spending an existing arm', async () => {
        const hook = await renderControls();
        await openPicker(hook);
        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.onSelectImmediate?.();
        });
        const localId = hook.getCurrent().armedContinuationLocalId;

        await hook.rerender({ featureDecision: null });

        // Presentation is closed while the decision is unknown, but uncertainty
        // is not evidence that a saved choice is invalid.
        expect(optionsOf(hook.getCurrent())).toEqual([CURRENT_AGENT_ROW]);
        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(readSessionDraftValue(null, 'session-1', 'routing.agentContinuation')).toBeDefined();

        await hook.rerender({ featureDecision: { state: 'enabled' } });

        expect(hook.getCurrent().armedContinuation?.selection.agentId).toBe('codex');
        expect(hook.getCurrent().armedContinuationLocalId).toBe(localId);
    });

    it('clears the previous Account arm so returning to it cannot resurrect the switch', async () => {
        const accountA = { serverId: 'server-1', accountId: 'account-a' } as const;
        const accountB = { serverId: 'server-1', accountId: 'account-b' } as const;
        const hook = await renderControls({ accountScope: accountA });
        await openPicker(hook);
        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.onSelectImmediate?.();
        });
        const accountALocalId = hook.getCurrent().armedContinuationLocalId;

        await hook.rerender({ accountScope: accountB });
        await act(async () => { await Promise.resolve(); });

        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(readSessionDraftValue(accountB, 'session-1', 'routing.agentContinuation')).toBeUndefined();
        expect(readSessionDraftValue(accountA, 'session-1', 'routing.agentContinuation')).toBeUndefined();

        await hook.rerender({ accountScope: accountA });
        await act(async () => { await Promise.resolve(); });

        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(hook.getCurrent().armedContinuationLocalId).not.toBe(accountALocalId);
    });

    it('keeps the first exact handoff snapshot for one stable localId', async () => {
        const hook = await renderControls();
        await openPicker(hook);
        await act(async () => {
            optionsOf(hook.getCurrent())[1]?.onSelectImmediate?.();
        });
        const localId = hook.getCurrent().armedContinuationLocalId;
        if (!localId) throw new Error('expected an armed localId');

        await act(async () => {
            expect(hook.getCurrent().recordArmedContinuationSubmission({
                localId,
                input: { text: 'first message', localId, meta: {} },
                currentness: {
                    text: 'first message',
                    mentions: [],
                    composerAttachments: [],
                    attachmentDraftIds: [],
                },
            })).toBe(true);
        });
        await act(async () => {
            expect(hook.getCurrent().recordArmedContinuationSubmission({
                localId,
                input: { text: 'newer retry', localId, meta: {} },
                currentness: {
                    text: 'newer retry',
                    mentions: [],
                    composerAttachments: [],
                    attachmentDraftIds: [],
                },
            })).toBe(true);
        });

        expect(hook.getCurrent().armedContinuationSubmission).toMatchObject({
            localId,
            input: { text: 'first message', localId },
            currentness: { text: 'first message' },
        });
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
            source: { ...supportedSource, currentBackendTargetKey: 'backend:gemini' },
        });

        expect(hook.getCurrent().armedContinuation).toBeNull();
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

    it('keeps an armed choice while the rail — and therefore the cancel gesture — is still there', async () => {
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
                entry('codex', {
                    capabilities: { session: { supported: false } } as ResolvedBackendCatalogEntry['capabilities'],
                }),
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

    it('re-inspects after the machine reports a new daemon, not only after a reconnect', async () => {
        // A daemon that restarts under a live realtime connection answers the
        // next inspection differently while `connectionGeneration` never moves.
        // That is exactly the window the reported defect lived in: the rail kept
        // offering targets the send path then refused as unsupported, for as long
        // as the client stayed connected.
        const hook = await renderControls();
        await openPicker(hook);
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1);

        await hook.rerender({ machine: { ...onlineMachine, daemonGeneration: 2 } });
        await act(async () => {
            await Promise.resolve();
        });

        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(2);
    });

    it('shows no Agent rail at all when nothing in this Session can be switched to', async () => {
        // The user's ruling: if switching is impossible, keep the composer's existing
        // model picker and drop the rail — no dead rows, no reason repeated per row,
        // no restatement in the detail pane.
        const hook = await renderControls({
            entries: [entry('claude'), entry('codex'), entry('gemini'), entry('cursor')],
            source: { ...supportedSource, storageKind: 'direct' },
        });
        await openPicker(hook);

        expect(optionsOf(hook.getCurrent())).toEqual([CURRENT_AGENT_ROW]);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
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

    it('shows no Agent rail to a reader who cannot send here', async () => {
        const hook = await renderControls({
            entries: [entry('claude'), entry('codex'), entry('gemini')],
            source: { ...supportedSource, canEditSession: false },
        });
        await openPicker(hook);

        expect(optionsOf(hook.getCurrent())).toEqual([CURRENT_AGENT_ROW]);
    });

    it('never calls a machine it already knows is offline, and offers no rail', async () => {
        const hook = await renderControls({
            entries: [entry('claude'), entry('codex'), entry('gemini')],
            source: { ...supportedSource, machinePresence: 'offline' },
        });
        await openPicker(hook);

        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        expect(optionsOf(hook.getCurrent())).toEqual([CURRENT_AGENT_ROW]);
    });

    it('drops the rail once every Agent in it has been refused', async () => {
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

    it('does not add the rail after a popover has already opened without it', async () => {
        // The popover shape is decided from facts available at its first visible
        // render. A late positive answer belongs to the next open; otherwise the
        // rail appears beside a reader who is already navigating the current-Agent
        // option.
        let resolveInspection: ((value: unknown) => void) | null = null;
        machineRpcWithServerScope.mockImplementation(() => new Promise((resolve) => {
            resolveInspection = resolve;
        }));
        const hook = await renderControls();

        await openPicker(hook);
        expect(optionsOf(hook.getCurrent()).map((option) => option.id))
            .toEqual(['engine:claude']);

        await act(async () => {
            resolveInspection?.(AVAILABLE);
            await Promise.resolve();
        });
        await act(async () => { await Promise.resolve(); });

        expect(optionsOf(hook.getCurrent()).map((option) => option.id))
            .toEqual(['engine:claude']);

        await act(async () => {
            hook.getCurrent().onAgentPickerVisibilityChange(false);
            hook.getCurrent().onAgentPickerVisibilityChange(true);
        });
        expect(optionsOf(hook.getCurrent()).map((option) => option.id))
            .toEqual(['engine:claude', 'backend:codex']);
    });

    it('holds a rail it has already shown for the rest of that open popover', async () => {
        const hook = await renderControls({ entries: [entry('claude'), entry('codex')] });
        await openPicker(hook);
        expect(optionsOf(hook.getCurrent()).map((option) => option.id))
            .toEqual(['engine:claude', 'backend:codex']);

        // A reconnect discards every answer read over the previous connection, so
        // the rows go back to being unanswered. That must not empty a rail the
        // reader is looking at.
        machineRpcWithServerScope.mockImplementation(() => new Promise(() => {}));
        await hook.rerender({ machine: { ...onlineMachine, connectionGeneration: 2 } });
        await act(async () => { await Promise.resolve(); });

        expect(optionsOf(hook.getCurrent()).map((option) => option.id))
            .toEqual(['engine:claude', 'backend:codex']);
    });

    it('keeps a target-specific block on its own row, said once, and never twice on screen', async () => {
        // One Agent is switchable, so the rail is live and the blocked Agent stays
        // in it — plainly disabled, with its own reason read once in the detail pane.
        const hook = await renderControls({
            entries: [
                entry('claude'),
                entry('codex'),
                entry('gemini', {
                    capabilities: { session: { supported: false } } as ResolvedBackendCatalogEntry['capabilities'],
                }),
            ],
        });
        await openPicker(hook);

        const options = optionsOf(hook.getCurrent());
        expect(options.map((option) => option.id)).toEqual([
            'engine:claude',
            'backend:codex',
            'backend:gemini',
        ]);
        const geminiOption = options[2];
        expect(geminiOption).toMatchObject({ disabled: true, muted: true });
        // Plainly disabled in the rail; the reason is read once, in the detail pane.
        expect(geminiOption?.subtitle).toBeUndefined();
        expect(geminiOption?.detailDescription)
            .toBe(t('session.agentContinuation.unavailable.targetNoSessions', { agent: 'gemini' }));
        expect(geminiOption?.onApply).toBeUndefined();
        expect(geminiOption?.onSelectImmediate).toBeUndefined();
    });
});
