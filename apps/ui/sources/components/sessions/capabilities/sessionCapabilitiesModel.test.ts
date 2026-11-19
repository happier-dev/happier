import { describe, expect, it } from 'vitest';
import { resolveSessionCapabilitiesV1 } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { SessionSkillPlanV1Schema } from '@happier-dev/protocol/prompts/library/skills/resolveSessionSkillPlanV1';
import { setSessionCapabilitySelectionItemV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { SessionCapabilitiesGetOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import type { CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { buildSessionCapabilitiesModel } from './sessionCapabilitiesModel';
import { t } from '@/text';
import { sessionCapabilityApplyNotice } from './sessionCapabilityApplyNotice';
import { resolveCapabilityApplyTimingV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';

const context = { machineId: 'machine', machinePlatform: 'posix', projectKey: 'project', directory: '/repo', agentId: 'codex' } as const;
const names = { machineName: () => 'MacBook', projectName: () => 'Project', agentName: () => 'Codex', agentNames: (ids: readonly string[]) => ids.map(() => 'Codex'), folderLabel: () => '~/repo' };
const rules = [{ id: 'project', target: { t: 'project', projectKey: 'project' }, enabled: true, createdAt: 1, updatedAt: 1 }] as const;
function fixture() {
    const selection = setSessionCapabilitySelectionItemV1({}, 'skill', 'review', 'on');
    const resolved = resolveSessionCapabilitiesV1({ context, selection, agentAcceptsUserMcp: true,
        mcp: { v: 1, strictMode: false, servers: [{ id: 'linear', name: 'linear', title: 'Linear', transport: 'http', remote: { url: 'https://example.test/mcp', headers: {} },
            env: {}, createdAt: 1, updatedAt: 1 }], bindings: [{ ...rules[0], enabled: false, serverId: 'linear' }] },
        skills: { items: [{ skillId: 'review', name: 'Review' }], rules: [{ ...rules[0], skillId: 'review' }] } });
    const view = SessionCapabilitiesGetOutputV1Schema.parse({ ok: true,
        mcp: { items: resolved.mcp.items.map(({ effectiveConfig: _config, ...item }) => item) },
        skills: { items: resolved.skills.items, plan: SessionSkillPlanV1Schema.parse({ plan: 'session_dir', items: [], nativeDisables: [], diagnostics: [] }) },
        pendingApply: { mcp: false, skills: false }, applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } } });
    if (!view.ok) throw new Error('Invalid fixture');
    return { view, selection, context, names, state: 'ready' as const, readOnly: false,
        rules: (kind: 'skill' | 'mcp_server') => kind === 'skill' ? rules : [{ ...rules[0], enabled: false }],
        mcpStatus: () => [] as readonly CapabilityStatus[], skillStatus: () => [] as readonly CapabilityStatus[],
        cost: (kind: 'skill' | 'mcp_server') => kind === 'skill' ? { tokensWhenUsed: 42 } : { toolCount: 3, tokensPerTurn: 123 } };
}
describe('the session capability sheet data owner', () => {
    it('offers both explicit bulk choices when one target has enabled a capability and another has disabled it', () => {
        const input = fixture();
        const off = setSessionCapabilitySelectionItemV1(input.selection, 'skill', 'review', 'off');
        const model = buildSessionCapabilitiesModel({ ...input,
            bulk: { selections: [input.selection, off] } });
        // The count is what the person needs to decide "Turn on" (lab copy "On in 2 of 6 sessions").
        expect(model.groups[0]?.rows[0]).toMatchObject({
            id: 'review', mixedLabel: t('session.participants.bulk.onInSessions', { count: 1, total: 2 }), action: { kind: 'turn_on', state: 'on' }, removalState: 'off',
        });
    });
    it('shows mixed capability reach when recipients share a Skill but their Machine defaults differ', () => {
        const input = fixture();
        const secondView = { ...input.view, skills: { ...input.view.skills, items: input.view.skills.items.map(item => ({
            ...item, selected: false, reachEnabled: false,
        })) } };
        const model = buildSessionCapabilitiesModel({ ...input, selection: {},
            bulk: { selections: [{}, {}], policyPreviews: [input.view, secondView] } });
        expect(model.groups[0]?.rows[0]).toMatchObject({
            id: 'review', mixedLabel: t('session.participants.bulk.onInSessions', { count: 1, total: 2 }),
        });
    });
    it('keeps the chip and open sheet on the same machine-resolved selection while Account rules refresh', () => {
        const input = fixture();
        const selection = setSessionCapabilitySelectionItemV1(input.selection, 'skill', 'review', 'inherit');
        const closed = buildSessionCapabilitiesModel({ ...input, selection, context: undefined, rules: () => [] });
        const open = buildSessionCapabilitiesModel({ ...input, selection, rules: () => [] });
        expect(open.counts).toEqual(closed.counts);
        expect(open.groups[0]?.rows[0]).toMatchObject({ id: 'review', dimmed: false });
        const removedSelection = setSessionCapabilitySelectionItemV1(selection, 'skill', 'review', 'off');
        const removed = buildSessionCapabilitiesModel({ ...input, selection: removedSelection, rules: () => [] });
        expect(removed.counts.skills).toBe(0);
        expect(removed.groups[0]?.rows[0]).toMatchObject({ id: 'review', dimmed: true });
    });
    it('says why a skill masked by the machine\'s own copy is read-only', () => {
        const input = fixture();
        const view = { ...input.view, skills: { ...input.view.skills, plan: SessionSkillPlanV1Schema.parse({ plan: 'session_dir',
            items: [{ skillId: 'review', name: 'review', digest: 'd1', state: 'masked_by_native', reason: 'native_same_name', maskedBy: { path: '/skills/review' } }], nativeDisables: [], diagnostics: [] }) } };
        const row = buildSessionCapabilitiesModel({ ...input, view, machineName: 'MacBook' }).groups[0]?.rows[0];
        expect(row).toMatchObject({ id: 'review', readOnlyReason: 'masked', action: { kind: 'none' },
            line2: { kind: 'status', status: { kind: 'masked', machineName: 'MacBook' } } });
    });
    it('keeps inherited rows and their scope unknown until rules arrive, then resolves the actual scope', () => {
        const input = fixture();
        const inherited = { ...input, selection: setSessionCapabilitySelectionItemV1(input.selection, 'skill', 'review', 'inherit') };
        const loading = buildSessionCapabilitiesModel({ ...inherited, context: undefined, rules: () => [] });
        expect(loading.groups[0]?.rows[0]).toMatchObject({ id: 'review', dimmed: false, scope: '' });
        expect(loading.addItems.some(item => item.id === 'review')).toBe(false);
        expect(buildSessionCapabilitiesModel({ ...inherited, rules: () => null }).groups[0]?.rows[0]).toMatchObject({ id: 'review', dimmed: false, scope: '' });
        expect(buildSessionCapabilitiesModel(inherited).groups[0]?.rows[0]?.scope).toBe('Only in Project');
        // A decided-by reference can arrive before its catalog row, including during refresh.
        expect(buildSessionCapabilitiesModel({ ...inherited, context: undefined, rules: () => [] }).groups[0]?.rows[0]?.scope).toBe('');
    });
    it('keeps Off MCP items in the add source, then projects a draft/session include through the same selection owner', () => {
        const input = fixture();
        const initial = buildSessionCapabilitiesModel(input);
        expect(initial.addItems).toMatchObject([{ kind: 'mcp_server', id: 'linear', title: 'Linear' }]);
        const next = buildSessionCapabilitiesModel({ ...input, selection: setSessionCapabilitySelectionItemV1(input.selection, 'mcp_server', 'linear', 'on') });
        expect(next.groups[1]?.rows).toMatchObject([{ key: 'mcp_server:linear', line2: { kind: 'change', change: 'added' } }]);
        expect(next.addItems).toEqual([]);
    });
    it('puts a problem ahead of a session change, quiet states behind cost, and preserves unknown cost', () => {
        const input = fixture();
        const blocked = buildSessionCapabilitiesModel({ ...input, skillStatus: () => [{ kind: 'signin' as const, fix: { kind: 'sign_in' as const, onPress() {} } }] });
        expect(blocked.groups[0]?.rows[0]).toMatchObject({ line2: { kind: 'status', status: { kind: 'signin' } }, action: { kind: 'fix' } });
        expect(blocked.attention).toBe(true);
        const inherited = { ...input, selection: setSessionCapabilitySelectionItemV1(input.selection, 'skill', 'review', 'inherit'),
            skillStatus: () => [{ kind: 'unused' as const }, { kind: 'connected' as const }] };
        expect(buildSessionCapabilitiesModel(inherited).groups[0]?.rows[0]?.line2).toEqual({ kind: 'cost', cost: { tokensWhenUsed: 42 } });
        const unknown = buildSessionCapabilitiesModel({ ...inherited, cost: () => null });
        expect(unknown.costKnown).toBe(false);
        expect(unknown.costLine).not.toContain('0');
    });
    it('keeps the cost line silent until the first preview answers, never claiming "unknown" while it loads', () => {
        const input = fixture();
        expect(buildSessionCapabilitiesModel({ ...input, view: null, selection: undefined, state: 'resolving' }).costLine).toBe('');
        expect(buildSessionCapabilitiesModel({ ...input, cost: () => null }).costLine).not.toBe('');
    });
    it('keeps dimmed removals and respects read-only/native masking and no-resume timing', () => {
        const input = fixture();
        const removed = buildSessionCapabilitiesModel({ ...input, selection: setSessionCapabilitySelectionItemV1(input.selection, 'skill', 'review', 'off') });
        expect(removed.groups[0]?.rows[0]).toMatchObject({ dimmed: true, line2: { kind: 'change', change: 'turned_off' }, action: { kind: 'turn_on' } });
        const readonly = buildSessionCapabilitiesModel({ ...input, readOnly: true });
        expect(readonly.groups[0]?.rows[0]?.action.kind).toBe('none');
        const cannotApply = buildSessionCapabilitiesModel({ ...input, view: { ...input.view, applyTiming: { mcp: { t: 'new_sessions_only' }, skills: { t: 'new_sessions_only' } } } });
        expect(cannotApply.groups[0]?.rows[0]?.action.kind).toBe('none');
        expect(cannotApply.addItems[0]?.readOnlyReason).not.toBeNull();
    });
    it('says once why no-resume rows are read-only, and keeps an account fix (Sign in) reachable on them', () => {
        const input = fixture();
        const included = { ...input, selection: setSessionCapabilitySelectionItemV1(input.selection, 'mcp_server', 'linear', 'on') };
        const timing = { mcp: { t: 'new_sessions_only' as const }, skills: { t: 'applied_now' as const } };
        const signIn = { kind: 'signin' as const, fix: { kind: 'sign_in' as const, onPress() {} } };
        const model = buildSessionCapabilitiesModel({ ...included, view: { ...included.view, applyTiming: timing }, mcpStatus: () => [signIn] });
        const mcp = model.groups[1];
        expect(mcp?.trailing).toBe('Applies to new sessions');
        expect(mcp?.rows[0]).toMatchObject({ readOnlyReason: 'new_sessions_only', action: { kind: 'fix', status: { kind: 'signin' } } });
        // Editable groups keep their own trailing words; a viewer gets no fix.
        expect(model.groups[0]?.trailing).toBe('Loaded when used');
        const viewer = buildSessionCapabilitiesModel({ ...included, readOnly: true, mcpStatus: () => [signIn] });
        expect(viewer.groups[1]?.rows[0]?.action.kind).toBe('none');
        expect(viewer.groups[1]?.trailing).toBe('Tools · tokens every turn');
    });
    it('does not offer native overlay edits on a non-resumable Agent that only reloads library skills', () => {
        const input = fixture();
        const model = buildSessionCapabilitiesModel({ ...input, nativeSkills: { items: [{ name: 'native-review', path: '/skills/review' }],
            canDisable: true, machineName: 'MacBook', agentName: 'Codex', applyTiming: { t: 'new_sessions_only' } } });
        expect(model.groups[0]?.nativeRow?.rows[0]).toMatchObject({ readOnlyReason: 'new_sessions_only', action: { kind: 'none' } });
    });
    it('reports a pending native overlay through its canonical next-turn timing on an Agent with live library reload', () => {
        const input = fixture();
        const agent = { vendorResume: 'supported', skillsLiveReload: 'supported' } as const;
        const nativeTiming = resolveCapabilityApplyTimingV1({ kind: 'native_skill', agent, sessionRunning: true, launchRestart: 'automatic' });
        const libraryTiming = resolveCapabilityApplyTimingV1({ kind: 'skill', agent, sessionRunning: true, launchRestart: 'automatic' });
        const change = { kind: 'native_skill', title: 'Native review', state: 'off' } as const;
        const pendingApply = { mcp: false, skills: true };
        const model = buildSessionCapabilitiesModel({ ...input, change,
            view: { ...input.view, pendingApply, applyTiming: { ...input.view.applyTiming, skills: libraryTiming } },
            nativeSkills: { items: [{ name: 'native-review', path: '/skills/review' }], canDisable: true,
                machineName: 'MacBook', agentName: 'Codex', applyTiming: nativeTiming } });
        const expected = sessionCapabilityApplyNotice({ change, pendingApply, applyTiming: { mcp: { t: 'next_turn' }, skills: nativeTiming },
            machineOnline: true, machineName: 'MacBook', turnSettled: true });
        expect(expected?.key).toBe('leavesNextTurn');
        expect(model.pendingNote).toBe(expected?.text);
        const withoutNativeCatalog = buildSessionCapabilitiesModel({ ...input, change,
            view: { ...input.view, pendingApply, applyTiming: { mcp: nativeTiming, skills: libraryTiming } } });
        expect(withoutNativeCatalog.applyNotice?.key).toBe('leavesNextTurn');
    });
});
