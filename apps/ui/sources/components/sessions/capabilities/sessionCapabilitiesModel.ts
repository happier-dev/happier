import type { SpawnCapabilitiesPreviewOutputV1, SessionCapabilitiesGetOutputV1 } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import type { SessionSkillPlanV1 } from '@happier-dev/protocol/prompts/library/skills/resolveSessionSkillPlanV1';
import { readSessionCapabilityOverrideV1, type SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { resolveSessionCapabilityItemSelected } from '@/sync/domains/capabilities/session/sessionCapabilitiesQuery';
import type { ReachContextV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import type { CapabilityApplyTimingV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import type { CapabilityCost } from '@/components/capabilities/facts/CapabilityFacts';
import { pickMostBlockingCapabilityStatus, presentCapabilityStatus, type CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { shortWhereItsOn, type WhereItsOnNames } from '@/components/capabilities/where/whereItsOnPresentation';
import { t } from '@/text';
import { sessionCapabilityApplyNotice, type SessionCapabilityApplyNotice, type SessionCapabilityApplyChange } from './sessionCapabilityApplyNotice';

export type SessionCapabilitiesViewInput = Extract<SpawnCapabilitiesPreviewOutputV1 | SessionCapabilitiesGetOutputV1, { ok: true }>;
export type SessionCapabilityRowModel = Readonly<{
    key: string; id: string; kind: 'skill' | 'mcp_server' | 'native_skill'; title: string;
    mark: 'none' | Readonly<{ mcpServerId: string }>;
    line2: Readonly<{ kind: 'status'; status: CapabilityStatus }> | Readonly<{ kind: 'change'; change: 'added' | 'turned_off' }>
        | Readonly<{ kind: 'cost'; cost: CapabilityCost }> | null;
    scope: string;
    action: Readonly<{ kind: 'fix'; status: CapabilityStatus }> | Readonly<{ kind: 'turn_on'; state: 'inherit' | 'on' }>
        | Readonly<{ kind: 'remove' | 'none' }>;
    mixedLabel?: string;
    removalState?: 'off';
    dimmed: boolean; readOnlyReason: 'viewer' | 'new_sessions_only' | 'masked' | 'native_disable_unsupported' | null;
}>;
/**
 * What this device last saw of one Session's sheet, kept in memory by the Session's chip while it lives, so a reopened
 * sheet holds the size it had and still shows the cost facts it knew while the re-read runs. Not persisted and never
 * the authority: any fresh read replaces it.
 */
export type SessionCapabilitiesLastKnown = Readonly<{
    rows: Readonly<{ skills: number; mcp: number }>;
    costs: ReadonlyMap<string, CapabilityCost>;
}>;
export type SessionCapabilityAddItem = Readonly<{ kind: 'skill' | 'mcp_server'; id: string; title: string; readOnlyReason: SessionCapabilityRowModel['readOnlyReason'] }>;
export type SessionCapabilitiesModel = Readonly<{
    chipLabel: string; counts: Readonly<{ skills: number; mcp: number }>; attention: boolean;
    groups: readonly Readonly<{ kind: 'skills' | 'mcp'; title: string; trailing: string;
        rows: readonly SessionCapabilityRowModel[]; nativeRow: Readonly<{ machineName: string; agentName: string; rows: readonly SessionCapabilityRowModel[] }> | null }>[];
    addItems: readonly SessionCapabilityAddItem[];
    /** The one apply line (`sessionCapabilityApplyNotice`); `pendingNote` is its text. */
    applyNotice: SessionCapabilityApplyNotice | null;
    pendingNote: string | null; costLine: string; costKnown: boolean;
    state: 'resolving' | 'ready' | 'machine_unreachable' | 'error';
}>;
export type SessionCapabilitiesModelInput = Readonly<{
    view: SessionCapabilitiesViewInput | null; state: SessionCapabilitiesModel['state'];
    selection?: SessionCapabilitySelectionV1; context?: ReachContextV1;
    bulk?: Readonly<{ selections: readonly SessionCapabilitySelectionV1[]; mixedLabel: string }>;
    skillPlan?: SessionSkillPlanV1 | null;
    mcpStatus(serverId: string): readonly CapabilityStatus[];
    skillStatus(skillId: string): readonly CapabilityStatus[];
    /** Null means the catalog has no known value yet, rather than a known empty rules list. */
    rules(kind: 'skill' | 'mcp_server', id: string): ReachRulesV1 | null;
    cost?: (kind: 'skill' | 'mcp_server', id: string) => CapabilityCost | null;
    names: WhereItsOnNames; readOnly: boolean;
    nativeSkills?: Readonly<{ items: readonly Readonly<{ name: string; path: string }>[]; canDisable: boolean; machineName: string; agentName: string;
        applyTiming: CapabilityApplyTimingV1 }>;
    applyState?: Readonly<{
        pendingApply: Extract<SessionCapabilitiesGetOutputV1, { ok: true }>['pendingApply'];
        applyTiming: Readonly<{ mcp: CapabilityApplyTimingV1; skills: CapabilityApplyTimingV1 }> | null;
    }>;
    change?: SessionCapabilityApplyChange | null; machineOnline?: boolean | null; machineName?: string; turnSettled?: boolean;
}>;

function formatTokenCount(value: number): string {
    return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value).toLowerCase();
}

/** Presentation only. Reach, optimistic overrides, statuses and apply timing retain their existing owners. */
export function buildSessionCapabilitiesModel(input: SessionCapabilitiesModelInput): SessionCapabilitiesModel {
    const skills: SessionCapabilityRowModel[] = [], mcp: SessionCapabilityRowModel[] = [], addItems: SessionCapabilityAddItem[] = [];
    let attention = false, skillCount = 0, mcpCount = 0, perTurn = 0, costKnown = input.view !== null;
    const plan = input.skillPlan ?? input.view?.skills.plan;
    for (const item of [...input.view?.skills.items ?? [], ...input.view?.mcp.items ?? []]) {
        const rules = input.rules(item.kind, item.id);
        const override = input.selection ? readSessionCapabilityOverrideV1(input.selection, item.kind, item.id)
            : item.sessionOverride === 'added' ? 'on' : item.sessionOverride === 'removed' ? 'off' : 'inherit';
        // The Machine preview owns reach (including its normalized workspace). Both
        // chip and sheet overlay the same optimistic Session selection on that fact.
        const selected = input.selection ? resolveSessionCapabilityItemSelected(item, override,
            item.kind !== 'mcp_server' || input.selection.mcp?.managedServersEnabled !== false) : item.selected;
        const mixed = input.bulk?.selections.some(selection => resolveSessionCapabilityItemSelected(item,
            readSessionCapabilityOverrideV1(selection, item.kind, item.id),
            item.kind !== 'mcp_server' || selection.mcp?.managedServersEnabled !== false) !== selected) ?? false;
        const timing = input.view?.applyTiming[item.kind === 'mcp_server' ? 'mcp' : 'skills'];
        const masked = item.kind === 'skill' && plan?.items.some(fact => fact.skillId === item.id && fact.state === 'masked_by_native') === true;
        const readOnlyReason = input.readOnly ? 'viewer' : masked ? 'masked' : timing?.t === 'new_sessions_only' ? 'new_sessions_only' : null;
        if (!mixed && !selected && override !== 'off') {
            addItems.push({ kind: item.kind, id: item.id, title: item.title ?? item.name,
                readOnlyReason: !item.selectable ? 'viewer' : readOnlyReason });
            continue;
        }
        if (selected) { if (item.kind === 'skill') skillCount++; else mcpCount++; }
        const statuses = item.kind === 'skill' ? input.skillStatus(item.id) : input.mcpStatus(item.id);
        // A skill the machine's own copy masks is read-only; its row says so rather than going silent.
        const status = pickMostBlockingCapabilityStatus(statuses.filter(status => presentCapabilityStatus(status, 'row').tone !== 'quiet'), 'row')
            ?? (masked ? { kind: 'masked' as const, ...(input.machineName ? { machineName: input.machineName } : {}) } : null);
        if (status && presentCapabilityStatus(status, 'row').tone === 'needs_you') attention = true;
        const cost = input.cost?.(item.kind, item.id) ?? null;
        // Per-turn cost is what MCP servers add every turn; skills cost only when an Agent loads them.
        if (selected && item.kind === 'mcp_server') { if (cost?.tokensPerTurn === undefined) costKnown = false; else perTurn += cost.tokensPerTurn; }
        const change = override === 'on' ? 'added' : override === 'off' ? 'turned_off' : null;
        const decidedBy = item.decidedBy;
        const decidingRule = decidedBy ? rules?.find(rule => rule.id === decidedBy.ruleId) : null;
        const row: SessionCapabilityRowModel = { key: `${item.kind}:${item.id}`, id: item.id, kind: item.kind, title: item.title ?? item.name,
            mark: item.kind === 'mcp_server' ? { mcpServerId: item.id } : 'none',
            line2: status ? { kind: 'status', status } : change ? { kind: 'change', change } : cost ? { kind: 'cost', cost } : null,
            scope: override === 'on' ? t('capabilities.session.thisSession') : rules === null || (decidedBy && !decidingRule) ? ''
                : shortWhereItsOn(decidingRule ? [decidingRule] : [], input.names),
            // An item's own fix (Sign in, Add key) is an Account action, so a row read-only for this session keeps it.
            action: readOnlyReason !== 'viewer' && status?.fix ? { kind: 'fix', status } : readOnlyReason ? { kind: 'none' }
                : !mixed && selected ? { kind: 'remove' } : { kind: 'turn_on',
                    // Clear a removal only when the Machine's deciding rule gives ON.
                    // An OFF/no-rule baseline needs a Session include to actually turn on.
                    state: !input.bulk && (decidingRule?.enabled ?? item.reason === 'rule_on') ? 'inherit' : 'on' },
            ...(mixed ? { mixedLabel: input.bulk?.mixedLabel } : {}),
            ...(input.bulk && (mixed || selected) ? { removalState: 'off' as const } : {}),
            dimmed: !mixed && !selected, readOnlyReason };
        (item.kind === 'skill' ? skills : mcp).push(row);
    }
    const order = (left: SessionCapabilityRowModel, right: SessionCapabilityRowModel) => {
        const rank = (row: SessionCapabilityRowModel) => row.line2?.kind === 'status' ? 0 : row.line2?.kind === 'change' ? 1 : 2;
        return rank(left) - rank(right) || left.title.localeCompare(right.title);
    };
    skills.sort(order); mcp.sort(order); addItems.sort((a, b) => a.title.localeCompare(b.title));
    const nativeRows = input.nativeSkills?.items.map((item): SessionCapabilityRowModel => {
        const off = input.selection?.skills?.excludeNativeSkillNames.includes(item.name) === true;
        const mixed = input.bulk?.selections.some(selection =>
            (readSessionCapabilityOverrideV1(selection, 'native_skill', item.name) === 'off') !== off) ?? false;
        const readOnlyReason = input.readOnly ? 'viewer' : input.nativeSkills!.applyTiming.t === 'new_sessions_only' ? 'new_sessions_only'
            : !input.nativeSkills!.canDisable ? 'native_disable_unsupported' : null;
        return { key: `native_skill:${item.name}`, id: item.name, kind: 'native_skill', title: item.name, mark: 'none',
            line2: off ? { kind: 'change', change: 'turned_off' } : null, scope: input.nativeSkills!.machineName,
            ...(mixed ? { mixedLabel: input.bulk?.mixedLabel, removalState: 'off' as const } : {}),
            dimmed: !mixed && off, readOnlyReason,
            action: readOnlyReason ? { kind: 'none' } : mixed || off ? { kind: 'turn_on', state: 'inherit' } : { kind: 'remove' } };
    });
    const pendingApply = input.applyState?.pendingApply ?? (input.view && 'pendingApply' in input.view ? input.view.pendingApply : { mcp: false, skills: false });
    const timing = input.applyState?.applyTiming ?? input.view?.applyTiming ?? null;
    // The view's skills timing describes library reload. Native overlays and MCP
    // share P2's launch-owned timing even before the native catalog is loaded.
    const applyTiming = timing && input.change?.kind === 'native_skill'
        ? { ...timing, skills: input.nativeSkills?.applyTiming ?? timing.mcp } : timing;
    const notice = sessionCapabilityApplyNotice({ pendingApply, applyTiming,
        change: input.change ?? null, machineOnline: input.machineOnline === undefined ? true : input.machineOnline, machineName: input.machineName ?? '', turnSettled: input.turnSettled === true });
    // A group whose rows can't change in this running session says so once, where its trailing words sit (INV-2).
    const newSessionsOnly = (rows: readonly SessionCapabilityRowModel[]) => rows.length > 0 && rows.every(row => row.readOnlyReason === 'new_sessions_only');
    const trailing = (rows: readonly SessionCapabilityRowModel[], words: string) => newSessionsOnly(rows)
        ? t('capabilities.session.apply.newSessionsOnly', { item: '', machine: '' }) : words;
    return { chipLabel: t('capabilities.session.counts', { skills: skillCount, mcp: mcpCount }), counts: { skills: skillCount, mcp: mcpCount }, attention,
        groups: [{ kind: 'skills', title: t('capabilities.skills.title'), trailing: trailing(skills, t('capabilities.session.loadedWhenUsed')), rows: skills,
            nativeRow: nativeRows?.length && input.nativeSkills ? { machineName: input.nativeSkills.machineName, agentName: input.nativeSkills.agentName, rows: nativeRows } : null },
            { kind: 'mcp', title: t('capabilities.session.mcpServers'), trailing: trailing(mcp, t('capabilities.session.toolsEveryTurn')), rows: mcp, nativeRow: null }],
        addItems, applyNotice: notice, pendingNote: notice?.text ?? null, costKnown: costKnown && perTurn > 0,
        // Before the first preview there is nothing to be unknown about: the footer waits silently.
        costLine: costKnown && perTurn > 0 ? t('capabilities.facts.tokensPerTurn', { count: formatTokenCount(perTurn) })
            : input.view === null && input.state === 'resolving' ? '' : t('capabilities.session.costUnknown'), state: input.state };
}
