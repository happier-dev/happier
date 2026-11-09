import { describe, expect, it } from 'vitest';
import { readSessionCapabilityApplyChange, sessionCapabilityApplyNotice, sessionSkillApplyNotice } from './sessionCapabilityApplyNotice';
import { readPendingCapabilityApplyV1, writeCapabilitySelectionApplyV1, clearCapabilitySelectionApplyV1, writeSessionCapabilitySelectionToMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1, SessionOwnerMetadataV1Schema, projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { setSessionCapabilitySelectionItemV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import type { CapabilityApplyTimingV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import { readSessionSkillApplicationFacts } from '@/sync/domains/capabilities/session/useSessionCapabilities';
import { SkillListItemV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { buildSkillComposerGroups, pickSkillComposerRow } from '@/sync/domains/skills/skillComposerGroups';
import { SessionCapabilitySelectionAuthoringV1Schema } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';

describe('the single session capability apply notice', () => {
    const notice = (input: Omit<Parameters<typeof sessionSkillApplyNotice>[0], 'facts'> & { metadata: unknown; skillId: string }) =>
        sessionSkillApplyNotice({ ...input, facts: readSessionSkillApplicationFacts(input.metadata, input.skillId) });
    it('only calls a saved skill live after its own desired selection is acknowledged', () => {
        const selected = setSessionCapabilitySelectionItemV1({}, 'skill', 'review', 'on');
        const pending = writeSessionCapabilitySelectionToMetadataV1({}, selected, { sessionActive: true });
        const input = { metadata: pending, skillId: 'review', title: 'Review', sessionRunning: true,
            applyTiming: { t: 'applied_now' } as const, machineOnline: true, machineName: 'QA', turnSettled: true };
        expect(notice(input)?.key).toBe('saved');
        const acknowledged = writeSessionCapabilitySelectionToMetadataV1({}, selected, { sessionActive: false });
        expect(notice({ ...input, metadata: acknowledged })?.key).toBe('addedNow');
        expect(notice({ ...input, metadata: acknowledged, sessionRunning: false })?.key).toBe('nextStart');
        expect(notice({ ...input, metadata: acknowledged, machineOnline: false })?.key).toBe('offline');
    });
    it('keeps a saved skill paired with its own apply record when MCP requires a terminal restart', () => {
        const selection = setSessionCapabilitySelectionItemV1(setSessionCapabilitySelectionItemV1({}, 'skill', 'review', 'on'), 'mcp_server', 'linear', 'on');
        const metadata = writeCapabilitySelectionApplyV1(writeSessionCapabilitySelectionToMetadataV1({}, selection, { sessionActive: true }), {
            mcp: { reason: 'restart_to_apply', restartBy: 'terminal' }, skills: { reason: 'next_turn' },
        });
        const input = { metadata, skillId: 'review', title: 'Review', sessionRunning: true,
            applyTiming: { t: 'applied_now' } as const, machineOnline: true, machineName: 'QA', turnSettled: true };
        expect(notice(input)?.key).toBe('joinsNextTurn');
        expect(notice({ ...input, skillId: 'other' })).toBeNull();
        for (const [reason, restartBy, key] of [['restart_to_apply', 'terminal', 'restartTerminal'], ['restart_to_apply', 'user', 'restart'],
            ['new_sessions_only', undefined, 'newSessionsOnly']] as const) {
            expect(notice({ ...input, metadata: writeCapabilitySelectionApplyV1(metadata, { skills: { reason, ...(restartBy ? { restartBy } : {}) } }) })?.key).toBe(key);
        }
    });
    it('presents an acknowledged inclusion refusal for new Sessions while no desired override was written', () => {
        expect(notice({ metadata: {}, skillId: 'review', title: 'Review', sessionRunning: true,
            inclusion: { ok: false, code: 'applies_to_new_sessions_only' }, applyTiming: null,
            machineOnline: null, machineName: 'QA', turnSettled: true })?.key).toBe('newSessionsOnly');
    });
    it('retains saved pending changes without an offline claim or restart action while Machine presence is unknown', () => {
        expect(sessionCapabilityApplyNotice({ pendingApply: { mcp: true, skills: false },
            applyTiming: { mcp: { t: 'restart_to_apply', restartBy: 'user' }, skills: { t: 'next_turn' } },
            change: null, machineOnline: null, machineName: 'QA', turnSettled: true,
        })).toMatchObject({ key: 'saved', restart: null });
    });
    const translate = (key: string, params?: Readonly<Record<string, string>>) => JSON.stringify([key, params ?? {}]);
    it.each([
        [{ t: 'next_turn' }, 'Changes apply at the next turn'],
        [{ t: 'applied_now' }, 'Changes apply at the next turn'],
    ] as const)('reads the rule apply-status producer through strict owner metadata for %j and clears on acknowledgment', (timing, text) => {
        const metadata = writeCapabilitySelectionApplyV1({}, { skills: { source: 'rules', reason: 'next_turn' } });
        const created = createSessionOwnerMetadataV1({ metadata });
        if (!created.ok) throw new Error('Rule status rejected by owner metadata');
        const projected = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: projectSessionSharedMetadataV1({ metadata }),
            ownerMetadata: SessionOwnerMetadataV1Schema.parse(created.ownerMetadata) });
        const notice = (value: unknown) => sessionCapabilityApplyNotice({ pendingApply: readPendingCapabilityApplyV1(value),
            applyTiming: { mcp: { t: 'next_turn' }, skills: timing }, change: readSessionCapabilityApplyChange(value, () => null),
            machineOnline: true, machineName: 'QA', turnSettled: false });
        expect(notice(projected)?.text).toBe(text);
        expect(notice(clearCapabilitySelectionApplyV1(projected, 'skills'))).toBeNull();
    });
    it('reads MCP rule pending and manual-restart words from the same strict owner producer without a Session override', () => {
        for (const [reason, restartBy, key] of [
            ['next_turn', undefined, 'pendingNextTurn'],
            ['restart_to_apply', 'terminal', 'restartTerminal'],
        ] as const) {
            const metadata = writeCapabilitySelectionApplyV1({}, { mcp: { source: 'rules', reason, ...(restartBy ? { restartBy } : {}) } });
            const created = createSessionOwnerMetadataV1({ metadata });
            if (!created.ok) throw new Error('MCP rule status rejected by owner metadata');
            const projected = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: projectSessionSharedMetadataV1({ metadata }),
                ownerMetadata: SessionOwnerMetadataV1Schema.parse(created.ownerMetadata) });
            const notice = (value: unknown) => sessionCapabilityApplyNotice({ pendingApply: readPendingCapabilityApplyV1(value),
                applyTiming: { mcp: { t: 'applied_now' }, skills: { t: 'applied_now' } },
                change: readSessionCapabilityApplyChange(value, () => null), machineOnline: true, machineName: 'QA', turnSettled: false });
            expect(notice(projected)?.key).toBe(key);
            expect(notice(clearCapabilitySelectionApplyV1(projected, 'mcp'))).toBeNull();
        }
    });
    it('uses the busy Claude owner record from QA-FIX20R3 instead of its live-reload declaration', () => {
        const owner = SessionOwnerMetadataV1Schema.parse({ v: 1, runtime: {
            agentRuntimeCapabilitiesV1: { capabilitySelection: { vendorResume: 'supported', skillsLiveReload: 'supported' } },
            capabilitySelectionApplyV1: { skills: { reason: 'next_turn', source: 'rules' } },
        } });
        const metadata = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: { v: 1 }, ownerMetadata: owner });
        expect(sessionCapabilityApplyNotice({
            pendingApply: readPendingCapabilityApplyV1(metadata),
            applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } },
            change: readSessionCapabilityApplyChange(metadata, () => null), machineOnline: true, machineName: 'QA', turnSettled: false,
        })?.key).toBe('pendingNextTurn');
    });
    it('keeps a rules change paired with its own record when MCP also has a refusal', () => {
        const selected = writeSessionCapabilitySelectionToMetadataV1({}, setSessionCapabilitySelectionItemV1({}, 'mcp_server', 'linear', 'on'), { sessionActive: true });
        const metadata = writeCapabilitySelectionApplyV1(selected, {
            mcp: { reason: 'restart_to_apply', restartBy: 'terminal' }, skills: { reason: 'next_turn', source: 'rules' },
        });
        expect(sessionCapabilityApplyNotice({ pendingApply: { ...readPendingCapabilityApplyV1(metadata), reason: 'restart_to_apply', restartBy: 'terminal' },
            applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } },
            change: readSessionCapabilityApplyChange(metadata, () => 'Linear'), machineOnline: true, machineName: 'QA', turnSettled: false })?.key).toBe('pendingNextTurn');
    });
    it('does not lend an aggregate MCP refusal to a library skill when both kinds are pending', () => {
        const input = { pendingApply: { mcp: true, skills: true, reason: 'new_sessions_only' },
            applyTiming: { mcp: { t: 'new_sessions_only' }, skills: { t: 'applied_now' } } as const,
            change: { kind: 'skill', title: 'Review', state: 'on' } as const,
            machineOnline: true, machineName: 'QA', turnSettled: true };
        expect(sessionCapabilityApplyNotice(input)?.key).toBe('addedNow');
        expect(sessionCapabilityApplyNotice({ ...input, change: { ...input.change, reason: 'next_turn' } })?.key).toBe('joinsNextTurn');
        expect(sessionCapabilityApplyNotice({ ...input, change: null })?.key).toBe('newSessionsOnly');
    });
    it.each(['skill', 'mcp_server', 'native_skill'] as const)('uses the runner reason for %s additions and removals, even without a preview', kind => {
        for (const state of ['on', 'off'] as const) {
            const input = { pendingApply: { mcp: kind === 'mcp_server', skills: kind !== 'mcp_server', reason: 'next_turn' },
                applyTiming: { mcp: { t: 'applied_now' }, skills: { t: 'applied_now' } } as const,
                change: { kind, title: 'Review', state }, machineOnline: true, machineName: 'QA', turnSettled: false };
            expect(sessionCapabilityApplyNotice(input)?.key).toBe(state === 'on' ? 'joinsNextTurn' : 'leavesNextTurn');
            expect(sessionCapabilityApplyNotice({ ...input, applyTiming: null })?.key).toBe(state === 'on' ? 'joinsNextTurn' : 'leavesNextTurn');
            expect(sessionCapabilityApplyNotice({ ...input, pendingApply: { ...input.pendingApply, reason: 'applied_now' },
                applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'next_turn' } } })?.key).toBe(state === 'on' ? 'addedNow' : 'removedNow');
            const baseline = writeSessionCapabilitySelectionToMetadataV1({}, setSessionCapabilitySelectionItemV1({}, kind, 'review', state === 'on' ? 'off' : 'on'), { sessionActive: false });
            const selected = writeSessionCapabilitySelectionToMetadataV1(baseline, setSessionCapabilitySelectionItemV1({}, kind, 'review', state), { sessionActive: true });
            const metadata = writeCapabilitySelectionApplyV1(selected, kind === 'mcp_server' ? { mcp: { reason: 'next_turn' } } : { skills: { reason: 'next_turn' } });
            // Native enable removes its exclusion; the canonical override is inherit.
            const key = kind === 'native_skill' && state === 'on' ? 'saved' : state === 'on' ? 'joinsNextTurn' : 'leavesNextTurn';
            expect(sessionCapabilityApplyNotice({ ...input, pendingApply: readPendingCapabilityApplyV1(metadata),
                change: readSessionCapabilityApplyChange(metadata, () => 'Review') })?.key).toBe(key);
        }
    });
    it.each([
        ['next_turn', 'pendingNextTurn'], ['applied_now', 'appliedNow'], ['new_sessions_only', 'newSessionsOnly'],
        ['session_not_running', 'nextStart'], ['apply_failed', 'saved'],
    ] as const)('uses the rules record %s ahead of static restart timing', (reason, key) => {
        expect(sessionCapabilityApplyNotice({ pendingApply: { mcp: false, skills: true, reason },
            applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'restart_to_apply', restartBy: 'terminal' } },
            change: { kind: 'skill', source: 'rules' }, machineOnline: true, machineName: 'QA', turnSettled: false })?.key).toBe(key);
    });
    it.each([
        [{ t: 'applied_now' }, 'on', 'Review added · applied now'],
        [{ t: 'applied_now' }, 'off', 'Review turned off · applied now'],
        [{ t: 'next_turn' }, 'on', 'Review joins at the next turn'],
        [{ t: 'next_turn' }, 'off', 'Review leaves at the next turn'],
        [{ t: 'new_sessions_only' }, 'on', 'Applies to new sessions'],
        [{ t: 'restart_to_apply', restartBy: 'user' }, 'on', 'Restart to apply'],
        [{ t: 'restart_to_apply', restartBy: 'terminal' }, 'on', 'Restart to apply · restart it from its terminal'],
    ] as const)('renders the §4.3 words for %j/%s', (timing, state, text) => {
        expect(sessionCapabilityApplyNotice({ pendingApply: { mcp: false, skills: true },
            applyTiming: { mcp: { t: 'next_turn' }, skills: timing },
            change: { kind: 'skill', title: 'Review', state }, machineOnline: true, machineName: 'MacBook', turnSettled: true })?.text).toBe(text);
    });
    it('renders the offline and missing-resume words from the same producer', () => {
        const input = { pendingApply: { mcp: false, skills: true }, applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'next_turn' } } as const,
            change: { kind: 'native_skill', title: 'Review', state: 'off' } as const, machineOnline: true, machineName: 'MacBook', turnSettled: true };
        expect(sessionCapabilityApplyNotice({ ...input, machineOnline: false })?.text).toBe('Applies when MacBook is back');
        expect(sessionCapabilityApplyNotice({ ...input, pendingApply: { ...input.pendingApply, reason: 'missing_resume_snapshot' } })?.text)
            .toBe("Couldn't apply · this session can't resume");
    });
    it('uses the same desired/applied metadata producer for a dollar pick and a sheet edit', async () => {
        const item = SkillListItemV1Schema.parse({ skillId: 'skill', name: 'review', description: null, revision: '1:1', rules: [],
            trust: 'text_only', cost: { bodyTokens: 1, descriptionTokens: 0 }, provenance: { kind: 'written' }, modified: false,
            updatePolicy: 'manual', createdAt: 1, migratedFromContext: false, userInvocable: true, folderId: null });
        const row = buildSkillComposerGroups({ open: true, query: '', agentId: 'codex', machineId: null,
            sessionItems: [], libraryItems: [item], found: null })[0]!.rows[0]!;
        let selection = SessionCapabilitySelectionAuthoringV1Schema.parse({});
        const pick = await pickSkillComposerRow(row, { setItem: (kind, id, state) => {
            selection = setSessionCapabilitySelectionItemV1(selection, kind, id, state);
        } });
        expect(pick).toEqual({ ok: true, mention: { kind: 'happier.skill', ref: 'skill:skill', token: '[review](happier-ref:skill:skill)', label: 'review' } });
        const pickedMetadata = writeSessionCapabilitySelectionToMetadataV1({}, selection, { sessionActive: true });
        const sheetMetadata = writeSessionCapabilitySelectionToMetadataV1({}, setSessionCapabilitySelectionItemV1({}, 'skill', 'skill', 'on'), { sessionActive: true });
        const notice = (metadata: unknown) => sessionCapabilityApplyNotice({ pendingApply: readPendingCapabilityApplyV1(metadata),
            applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'next_turn' } },
            change: readSessionCapabilityApplyChange(metadata, () => 'Review'), machineOnline: true, machineName: 'MacBook', turnSettled: true, translate });
        expect(notice(pickedMetadata)).toEqual(notice(sheetMetadata));
        expect(notice(pickedMetadata)?.key).toBe('joinsNextTurn');
    });
    it('reads every surface’s real desired/applied metadata and uses one generic line for several changes', () => {
        const selection = setSessionCapabilitySelectionItemV1({}, 'mcp_server', 'linear', 'on');
        const metadata = writeSessionCapabilitySelectionToMetadataV1({}, selection, { sessionActive: true });
        expect(readSessionCapabilityApplyChange(metadata, () => 'Linear')).toEqual({ kind: 'mcp_server', title: 'Linear', state: 'on' });
        const two = writeSessionCapabilitySelectionToMetadataV1(metadata, setSessionCapabilitySelectionItemV1(selection, 'native_skill', 'review', 'off'), { sessionActive: true });
        expect(readSessionCapabilityApplyChange(two, (_kind, id) => id)).toBeNull();
        expect(readSessionCapabilityApplyChange(metadata, () => null)).toBeNull();
    });
    it('does not promise next-turn application while runtime timing is unavailable', () => {
        expect(sessionCapabilityApplyNotice({ pendingApply: { mcp: true, skills: false }, applyTiming: null,
            change: { kind: 'mcp_server', title: 'Linear', state: 'on' }, machineOnline: true, machineName: 'MacBook',
            turnSettled: true, translate })?.key).toBe('saved');
    });
    it('does not reinterpret a pending live reload as next-turn when the changed items are unknown', () => {
        expect(sessionCapabilityApplyNotice({ pendingApply: { mcp: false, skills: true },
            applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } }, change: null,
            machineOnline: true, machineName: 'MacBook', turnSettled: true })?.text).toBe('Change saved');
    });
    it('uses the canonical live apply timing even while the selection marker is pending', () => {
        const input = { pendingApply: { mcp: false, skills: true }, applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } } as const,
            change: { kind: 'skill', title: 'Review', state: 'on' } as const, machineOnline: true, machineName: 'MacBook', turnSettled: true, translate };
        expect(sessionCapabilityApplyNotice(input)?.key).toBe('addedNow');
        expect(sessionCapabilityApplyNotice({ ...input, pendingApply: { mcp: false, skills: false } })?.key).toBe('addedNow');
    });
    it('reports turning a running session skill off with the exact apply-table words', () => {
        const metadata = writeSessionCapabilitySelectionToMetadataV1({}, setSessionCapabilitySelectionItemV1({}, 'skill', 'review', 'off'), { sessionActive: true });
        expect(sessionCapabilityApplyNotice({ pendingApply: readPendingCapabilityApplyV1(metadata),
            applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } },
            change: readSessionCapabilityApplyChange(metadata, () => 'Review'), machineOnline: true, machineName: 'MacBook', turnSettled: true }))
            .toEqual({ key: 'removedNow', text: 'Review turned off · applied now', restart: null });
    });
    it.each([
        [{ t: 'applied_now' }, 'on', 'addedNow'], [{ t: 'applied_now' }, 'off', 'removedNow'],
        [{ t: 'next_turn' }, 'on', 'joinsNextTurn'], [{ t: 'next_turn' }, 'off', 'leavesNextTurn'],
        [{ t: 'new_sessions_only' }, 'on', 'newSessionsOnly'], [{ t: 'session_not_running' }, 'on', 'nextStart'],
        [{ t: 'restart_to_apply', restartBy: 'user' }, 'on', 'restart'],
        [{ t: 'restart_to_apply', restartBy: 'terminal' }, 'on', 'restartTerminal'],
    ] as const)('projects %j/%s without deciding apply timing again', (timing, state, key) => {
        const notice = sessionCapabilityApplyNotice({ pendingApply: { mcp: timing.t !== 'applied_now', skills: false },
            applyTiming: { mcp: timing as CapabilityApplyTimingV1, skills: { t: 'applied_now' } },
            change: { kind: 'mcp_server', title: 'Linear', state }, machineOnline: true, machineName: 'MacBook',
            turnSettled: true, translate });
        expect(notice?.key).toBe(key);
        expect(notice?.restart).toBe(timing.t === 'restart_to_apply' && timing.restartBy === 'user' ? 'enabled' : null);
    });
    it('reads pending and refusal facts for both kinds and clears after acknowledgment', () => {
        const input = { pendingApply: { mcp: false, skills: true }, applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'next_turn' } } as const,
            change: { kind: 'native_skill', title: 'Review', state: 'off' } as const, machineOnline: true, machineName: 'MacBook', turnSettled: false, translate };
        expect(sessionCapabilityApplyNotice(input)?.key).toBe('leavesNextTurn');
        expect(sessionCapabilityApplyNotice({ ...input, pendingApply: { mcp: false, skills: false }, change: null })).toBeNull();
        expect(sessionCapabilityApplyNotice({ ...input, machineOnline: false })?.key).toBe('offline');
        expect(sessionCapabilityApplyNotice({ ...input, pendingApply: { ...input.pendingApply, reason: 'missing_resume_snapshot' } })?.key).toBe('cannotResume');
        expect(sessionCapabilityApplyNotice({ ...input, applyTiming: { ...input.applyTiming, skills: { t: 'restart_to_apply', restartBy: 'user' } } })?.restart).toBe('disabled');
    });
    it('shows an acknowledged live edit once; a refreshable producer never fabricates zero cost or an item name', () => {
        const input = { pendingApply: { mcp: false, skills: false }, applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } } as const,
            change: { kind: 'skill', title: 'Review', state: 'on' } as const, machineOnline: true, machineName: 'MacBook', turnSettled: true, translate };
        expect(sessionCapabilityApplyNotice(input)?.key).toBe('addedNow');
        expect(sessionCapabilityApplyNotice({ ...input, change: null })).toBeNull();
    });
});
