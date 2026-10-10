import { isInProgressAgentActivityStatus, type AgentActivityStatusV1 } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityStatusV1';

import type { IconName } from '@/components/ui/icons/Icon';
import type { StatusPillVariant } from '@/components/ui/status/StatusPill';
import { resolveWorkStatusTone, WORK_STATUS_PILL_VARIANT, type WorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import type {
    AgentActivityEntry,
    AgentActivityEntryKind,
    SessionAgentActivityAttentionKind,
} from '@/sync/domains/session/agentActivity';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { t } from '@/text';

import { resolveSessionSubagentKindLabelKey } from './resolveSessionSubagentKindLabelKey';
import { resolveSessionSubagentPrimaryTitle } from './resolveSessionSubagentPrimaryTitle';
import { WORKER_KIND_GLYPHS } from '@/components/sessions/work/workerKindGlyphs';

/**
 * Everything a surface needs to draw one unit of Session agent work — resolved once, for everyone.
 *
 * Before this module the roster row, the Details overview card and the Agents panel each resolved
 * their own title, their own subtitle, their own status colour and their own attention badge from
 * overlapping inputs. They disagreed: the row painted the RAW status token (`timedOut`) with a
 * hand-rolled accent, the card painted the raw token in grey, and neither could say that an agent
 * had asked a QUESTION rather than requested an approval.
 *
 * The rule this module enforces is that presentation reads the MERGED `AgentActivityEntry` — the
 * canonical status and attention — and uses the local `SessionSubagent` only for detail the entry
 * genuinely does not carry (the live title, the provider label, the run id). A host that still had
 * a subagent in hand and rendered `subagent.status` would silently disagree with the roster the
 * moment the publisher reported a terminal outcome first.
 *
 * It is a pure function, not a component and not a hook, so a conversation timeline, a roster and a
 * Details panel can each compose the result into their own legitimate geometry without inheriting a
 * card's chrome or growing `compact`/`showActions` booleans on one monolith.
 */

export type SessionAgentActivityAttentionPresentation = Readonly<{
    /** One short phrase for the badge — never two badges stacked in a dense row. */
    label: string;
    variant: StatusPillVariant;
    /** Spoken form, which names every pending kind even when the badge condenses them. */
    description: string;
}>;

/**
 * Where a unit of work stands for the person reading the roster: waiting on them, still working, or
 * finished. It decides the mark's corner (amber dot, live ring, none), the subtitle's lead and
 * whether time reads as a running clock or as "when".
 */
export type SessionAgentActivityPhase = 'attention' | 'live' | 'idle' | 'finished';

export type SessionAgentActivityPresentation = Readonly<{
    title: string;
    phase: SessionAgentActivityPhase;
    /** The Agent behind the work, for its brand mark; `null` draws the neutral glyph. */
    agentId: string | null;
    /** When the work started, for a live row's running clock. */
    startedAtMs: number | null;
    /** The moment a finished or waiting row is dated by. */
    atMs: number | null;
    /**
     * Secondary facts in canonical order, deduplicated, for the one line under the title.
     *
     * Ordered least- to most-specific (what kind of work, who runs it, which team, what it is
     * about, which run), so truncation drops identifiers before it drops meaning.
     */
    facts: readonly string[];
    statusLabel: string;
    /** The one work-status tone for this status (INT §5.3): the word's colour wherever it is drawn. */
    statusTone: WorkStatusTone;
    /** Running is said by the activity ring and the clock, so its word is not repeated beside them. */
    statusShownByActivity?: boolean;
    /** Present only while a person is the blocker. */
    attention: SessionAgentActivityAttentionPresentation | null;
    iconName: IconName;
    /** The theme accent name for the leading icon, when a local source supplied one. */
    accentName: string | null;
    /** The whole summary as one spoken string, so a row announces itself in one utterance. */
    accessibilityLabel: string;
}>;

const STATUS_LABEL_KEYS = {
    queued: 'sessionAgentActivity.status.queued',
    starting: 'sessionAgentActivity.status.starting',
    running: 'sessionAgentActivity.status.running',
    waiting: 'sessionAgentActivity.status.waiting',
    blocked: 'sessionAgentActivity.status.blocked',
    succeeded: 'sessionAgentActivity.status.succeeded',
    failed: 'sessionAgentActivity.status.failed',
    timedOut: 'sessionAgentActivity.status.timedOut',
    cancelled: 'sessionAgentActivity.status.cancelled',
    unknown: 'sessionAgentActivity.status.unknown',
} as const satisfies Record<AgentActivityStatusV1, string>;

/**
 * How a status is coloured: its tone comes from the one work-status owner (INT I3), so a roster row,
 * a Work row and a run card agree. Healthy work is neutral; waiting and a timeout ask for attention
 * and only a failure is danger.
 */
function statusTone(status: AgentActivityStatusV1): WorkStatusTone {
    return resolveWorkStatusTone({ kind: 'agent_activity', facts: { status, word: '' } }).tone;
}

function statusVariant(status: AgentActivityStatusV1): StatusPillVariant {
    return WORK_STATUS_PILL_VARIANT[statusTone(status)];
}

const KIND_ICON_NAMES = {
    execution_run: WORKER_KIND_GLYPHS.execution_run,
    agent_team_member: 'users',
    subagent: WORKER_KIND_GLYPHS.session,
    workflow_run: WORKER_KIND_GLYPHS.workflow_run,
    workflow_agent: WORKER_KIND_GLYPHS.session,
} as const satisfies Record<AgentActivityEntryKind, IconName>;

/**
 * An execution run's canonical status (`running`, `timeout`, …) read into the agent-activity
 * vocabulary every roster row speaks. A status the run owner has not defined reads as `unknown`.
 */
export function readExecutionRunAgentActivityStatus(status: unknown): AgentActivityStatusV1 {
    switch (status) {
        case 'running': return 'running';
        case 'succeeded': return 'succeeded';
        case 'failed': return 'failed';
        case 'cancelled': return 'cancelled';
        case 'timeout': return 'timedOut';
        default: return 'unknown';
    }
}

/**
 * The words and colour of one canonical status, for surfaces that show a status without a roster
 * entry around it (the running Agent conversation's header). Same vocabulary as every roster row.
 */
export function resolveAgentActivityStatusPresentation(status: AgentActivityStatusV1, isActive?: boolean): Readonly<{
    label: string;
    variant: StatusPillVariant;
}> {
    return { label: status === 'running' && isActive === false
        ? t('diagnosis.machineRuns.idle') : t(STATUS_LABEL_KEYS[status]), variant: statusVariant(status) };
}

function resolveAttention(
    attentionKinds: readonly SessionAgentActivityAttentionKind[],
): SessionAgentActivityAttentionPresentation | null {
    const wantsApproval = attentionKinds.includes('permission');
    const wantsAnswer = attentionKinds.includes('user_action');

    if (wantsApproval && wantsAnswer) {
        // One badge, both facts. A row that stacked two badges would push the title into a second
        // line exactly when the row most needs to be legible at a glance.
        return {
            label: t('sessionAgentActivity.attention.both'),
            variant: WORK_STATUS_PILL_VARIANT.attention,
            description: t('sessionAgentActivity.attention.bothDescription'),
        };
    }
    if (wantsApproval) {
        const label = t('sessionAgentActivity.attention.permission');
        return { label, variant: WORK_STATUS_PILL_VARIANT.attention, description: label };
    }
    if (wantsAnswer) {
        const label = t('sessionAgentActivity.attention.userAction');
        return { label, variant: WORK_STATUS_PILL_VARIANT.attention, description: label };
    }
    return null;
}

function resolveTitle(entry: AgentActivityEntry, subagent: SessionSubagent | null): string {
    // The local title is the live one and knows not to show a run id as a name; the entry title is
    // what the publisher sent, which is all an unloaded row has.
    const localTitle = subagent ? resolveSessionSubagentPrimaryTitle(subagent).trim() : '';
    if (localTitle.length > 0) return localTitle;
    const entryTitle = entry.title.trim();
    return entryTitle.length > 0 ? entryTitle : entry.id;
}

/**
 * What kind of work a Run is, in the person's words: an interactive Agent conversation, a Review, a
 * Plan. Read from the Run's canonical intent and class; a Run with neither keeps the generic kind.
 */
function resolveRunKindLabel(subagent: SessionSubagent): string | null {
    if (subagent.kind !== 'execution_run') return null;
    const intent = subagent.runRef?.intent?.trim();
    if (intent === 'review') return t('sessionAgentActivity.runKind.review');
    if (intent === 'plan') return t('sessionAgentActivity.runKind.plan');
    if (intent === 'delegate' && subagent.runRef?.runClass?.trim() === 'long_lived') {
        return t('sessionAgentActivity.runKind.conversation');
    }
    return null;
}

function resolveFacts(
    entry: AgentActivityEntry,
    subagent: SessionSubagent | null,
    originLabel: string | null,
): readonly string[] {
    const teamLabel = subagent?.kind === 'agent_team_member'
        ? subagent.display.groupLabel?.trim()
            || subagent.display.groupKey?.trim()
            || (subagent.recipient?.kind === 'agent_team_member' ? subagent.recipient.teamId.trim() : null)
        : null;
    const intent = subagent?.runRef?.intent?.trim() ?? null;
    const subtitle = subagent?.display.subtitle?.trim() ?? entry.metaDetail?.trim() ?? null;
    const title = resolveTitle(entry, subagent);
    const runId = entry.runId?.trim() ?? null;

    const candidates = [
        subagent ? resolveRunKindLabel(subagent) ?? t(resolveSessionSubagentKindLabelKey(subagent.kind)) : null,
        originLabel?.trim() || null,
        subagent?.display.providerLabel?.trim() || subagent?.runRef?.backendId?.trim() || null,
        teamLabel,
        // A Run's subtitle is its raw intent token (`delegate`); the kind above already says it in words.
        subtitle && subtitle !== intent ? subtitle : null,
        // The run id only when it is the one thing naming the row; a named row keeps it in Run details.
        runId && title === runId ? runId : null,
    ];

    const facts: string[] = [];
    for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        const value = candidate.trim();
        // Deduplicated because the same string legitimately reaches two slots — a subtitle that is
        // just the provider name, a title that is the run id — and repeating it reads as a bug.
        if (value.length === 0 || facts.includes(value)) continue;
        facts.push(value);
    }
    return facts;
}

function resolvePhase(
    status: AgentActivityStatusV1,
    attention: SessionAgentActivityAttentionPresentation | null,
    isActive?: boolean,
): SessionAgentActivityPhase {
    if (attention) return 'attention';
    if (status === 'running' && isActive === false) return 'idle';
    return isInProgressAgentActivityStatus(status) ? 'live' : 'finished';
}

/**
 * The Agent whose mark the row carries. A Run names its own backend; every other unit (a Task
 * subagent, a teammate) is run by the Session's own Agent, which the host passes in.
 */
function resolveAgentId(subagent: SessionSubagent | null, sessionAgentId: string | null): string | null {
    const backendId = subagent?.runRef?.backendId?.trim();
    if (backendId) return backendId;
    const trimmed = sessionAgentId?.trim();
    return trimmed ? trimmed : null;
}

function readFiniteMs(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** A running clock: `0:41`, `4:03`, `1:02:07`. Tabular, so a ticking row never shifts. */
export function formatAgentActivityElapsed(elapsedMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const ss = String(seconds).padStart(2, '0');
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

export function resolveSessionAgentActivityPresentation(params: Readonly<{
    entry: AgentActivityEntry;
    /** The locally derived row behind the entry, when this host loaded one. */
    subagent?: SessionSubagent | null;
    /** Where the work came from ("from Relay retry plan"), when the host resolved it. */
    originLabel?: string | null;
    /** The Session's own Agent, which runs every unit that does not name its own backend. */
    sessionAgentId?: string | null;
}>): SessionAgentActivityPresentation {
    const { entry } = params;
    const subagent = params.subagent ?? null;
    const title = resolveTitle(entry, subagent);
    const statusLabel = resolveAgentActivityStatusPresentation(entry.status, entry.isActive).label;
    const attention = resolveAttention(entry.attentionKinds);
    const phase = resolvePhase(entry.status, attention, entry.isActive);
    const startedAtMs = readFiniteMs(entry.startedAtMs) ?? readFiniteMs(subagent?.timestamps.startedAtMs);
    const endedAtMs = readFiniteMs(entry.endedAtMs) ?? readFiniteMs(subagent?.timestamps.finishedAtMs);

    return {
        title,
        phase,
        agentId: resolveAgentId(subagent, params.sessionAgentId ?? null),
        startedAtMs: phase === 'idle' ? null : startedAtMs,
        atMs: phase === 'idle' ? null : phase === 'finished'
            ? endedAtMs ?? readFiniteMs(subagent?.timestamps.updatedAtMs) ?? startedAtMs
            : readFiniteMs(subagent?.timestamps.updatedAtMs) ?? startedAtMs,
        facts: resolveFacts(entry, subagent, params.originLabel ?? null),
        statusLabel,
        statusTone: statusTone(entry.status),
        statusShownByActivity: entry.isActive !== false && entry.status === 'running',
        attention,
        iconName: KIND_ICON_NAMES[entry.kind],
        accentName: subagent?.display.accentName?.trim() || null,
        accessibilityLabel: attention
            ? t('sessionAgentActivity.summaryAttentionA11y', {
                title,
                status: statusLabel,
                attention: attention.description,
            })
            : t('sessionAgentActivity.summaryA11y', { title, status: statusLabel }),
    };
}
