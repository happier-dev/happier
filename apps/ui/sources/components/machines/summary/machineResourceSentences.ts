import {
    MachinePublishedResourceSummaryV1Schema,
    type MachinePublishedResourceSummaryV1,
    type MachineResourceAttentionV1,
    type MachineResourceAutomaticActionV1,
    type MachineResourceReasonV1,
} from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';

import type { MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';
import { machineDiskName } from '@/components/machines/storage/storageViewModel';
import { t } from '@/text';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

/**
 * The one owner of every machine sentence (MPG-28): the fleet title and its description, a machine's
 * sentence under its name, the rail tooltip, the needs-you rows and the attention items. Pure, over plan
 * 20's published attention (never a number re-read here), with whole-sentence keys per locale.
 */

/** A machine's published resource summary (daemonState `resources`), read through its schema; `null` when it publishes none. */
export function readMachinePublishedResources(daemonState: unknown): MachinePublishedResourceSummaryV1 | null {
    const resources = typeof daemonState === 'object' && daemonState !== null && 'resources' in daemonState
        ? (daemonState as { resources?: unknown }).resources : null;
    const parsed = MachinePublishedResourceSummaryV1Schema.safeParse(resources);
    return parsed.success ? parsed.data : null;
}

/** One machine as the sentences name it. */
export type MachineAttentionSubject = Readonly<{ name: string; attention: MachineResourceAttentionV1 }>;

export type MachineAttentionTone = 'calm' | 'look' | 'needs_you';

/** The reason a machine is listed first: its worst reason (needs you before worth a look, then the oldest). */
export function selectHeadlineReason(attention: MachineResourceAttentionV1): MachineResourceReasonV1 | null {
    if (attention.reasons.length === 0) return null;
    return [...attention.reasons].sort((left, right) => (left.level === right.level ? left.since - right.since : left.level === 'needs_you' ? -1 : 1))[0]!;
}

const LIMIT_NOUN_KEYS = {
    files: 'machineAttention.limits.files',
    ptys: 'machineAttention.limits.ptys',
    processes: 'machineAttention.limits.processes',
    inotify: 'machineAttention.limits.inotify',
} as const;

/**
 * The value a row shows beside its attention word: the figure of the metric that needs attention ("Short on memory ·
 * 82%"), which the word labels. A limit has no instrument; without a reading there is no value yet.
 */
export function describeMachineAttentionFigure(reason: MachineResourceReasonV1,
    figures: Readonly<Record<'cpu' | 'memory' | 'disk' | 'network', Readonly<{ figure: string | null }>>> | null): string | null {
    if (!figures || reason.metric === 'limits') return null;
    return figures[reason.metric].figure;
}

/** The reason in a word or two, for where there is no room for a sentence ("Short on memory", "/data nearly full"). */
export function describeMachineAttentionWord(reason: MachineResourceReasonV1): string {
    switch (reason.kind) {
        case 'memory_pressure':
            return reason.pressure === 'critical' ? t('machineAttention.words.memoryCritical') : t('machineAttention.words.memoryElevated');
        case 'disk_nearly_full':
            return t('machineAttention.words.diskNearlyFull', { volume: machineDiskName({ label: reason.volumeLabel }) });
        case 'disk_full':
            return t('machineAttention.words.diskFull', { volume: machineDiskName({ label: reason.volumeLabel }) });
        case 'limit_reached':
            return t('machineAttention.words.limitReached', { limit: t(LIMIT_NOUN_KEYS[reason.limit]) });
        case 'guard_out_of_steps':
            return t('machineAttention.words.guardOutOfSteps');
    }
}

/** The reason as a sentence about the machine ("edge-1 is short on memory", "nl2's /data is nearly full"). */
export function describeMachineReasonPhrase(name: string, reason: MachineResourceReasonV1): string {
    switch (reason.kind) {
        case 'memory_pressure':
            return reason.pressure === 'critical'
                ? t('machineAttention.phrases.memoryCritical', { machine: name })
                : t('machineAttention.phrases.memoryElevated', { machine: name });
        case 'disk_nearly_full':
            return t('machineAttention.phrases.diskNearlyFull', { machine: name, volume: machineDiskName({ label: reason.volumeLabel }, 'sentence') });
        case 'disk_full':
            return t('machineAttention.phrases.diskFull', { machine: name, volume: machineDiskName({ label: reason.volumeLabel }, 'sentence') });
        case 'limit_reached':
            return t('machineAttention.phrases.limitReached', { machine: name, limit: t(LIMIT_NOUN_KEYS[reason.limit]) });
        case 'guard_out_of_steps':
            return t('machineAttention.phrases.guardOutOfSteps', { machine: name });
    }
}

/** "6 min", "2 h", "3 d": how long a reason has held. */
export function formatAttentionDuration(sinceMs: number, nowMs: number): string {
    const minutes = Math.max(1, Math.round((nowMs - sinceMs) / 60_000));
    if (minutes < 60) return t('machineAttention.duration.minutes', { count: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 48) return t('machineAttention.duration.hours', { count: hours });
    return t('machineAttention.duration.days', { count: Math.round(hours / 24) });
}

/** The one line of detail under a needs-you reason ("Swapping for 6 min.", "412 of 1024 open files in use."). */
export function describeMachineReasonDetail(reason: MachineResourceReasonV1, nowMs: number): string {
    const duration = formatAttentionDuration(reason.since, nowMs);
    switch (reason.kind) {
        case 'memory_pressure':
            return reason.swapping
                ? t('machineAttention.details.swapping', { duration })
                : t('machineAttention.details.pressure', { duration });
        case 'disk_nearly_full':
        case 'disk_full':
            return t('machineAttention.details.disk', { duration });
        case 'limit_reached':
            return t('machineAttention.details.limit', { used: reason.used, max: reason.max, limit: t(LIMIT_NOUN_KEYS[reason.limit]) });
        case 'guard_out_of_steps':
            return t('machineAttention.details.guardOutOfSteps');
    }
}

/** A reason's one action: the tab it opens (the tolerant tab reader shows Overview until that tab exists). */
export function resolveMachineReasonAction(reason: MachineResourceReasonV1): Readonly<{ label: string; tab: MachinePageTabParams }> | null {
    if (reason.nextStep === 'review_processes') return { label: t('machineAttention.actions.reviewProcesses'), tab: { id: 'processes', sort: 'memory' } };
    if (reason.nextStep === 'free_up_space') {
        // The disk it names opens prepared (plan 40 STO-23): the entry's tap fills the pile, see `beginMachinePageTabIntent`.
        const volumeId = 'volumeId' in reason ? reason.volumeId : null;
        return { label: t('machineAttention.actions.freeUpSpace'), tab: volumeId ? { id: 'storage', prepare: 'lowDisk', volumeId } : { id: 'storage' } };
    }
    return null;
}

/** The subjects that need a look or need you, worst first (needs you, then the longest-standing). */
export function selectAttentionSubjects<T extends MachineAttentionSubject>(subjects: readonly T[]): readonly T[] {
    return subjects
        .filter(subject => subject.attention.level !== 'calm' && subject.attention.reasons.length > 0)
        .sort((left, right) => {
            const l = left.attention.level === 'needs_you' ? 0 : 1;
            const r = right.attention.level === 'needs_you' ? 0 : 1;
            if (l !== r) return l - r;
            return (selectHeadlineReason(left.attention)?.since ?? 0) - (selectHeadlineReason(right.attention)?.since ?? 0);
        });
}

/**
 * The fleet in one title (All machines, the popover, the phone Settings row): "2 machines need a look",
 * "edge-1 is short on memory", "All calm". `null` while no machine reports
 * resources, so the surface keeps its plain title.
 */
export function describeFleetTitle(input: Readonly<{ subjects: readonly MachineAttentionSubject[]; reportingCount: number }>): string | null {
    if (input.reportingCount === 0) return null;
    const attention = selectAttentionSubjects(input.subjects);
    if (attention.length === 0) return t('machineAttention.fleet.calm');
    if (attention.length === 1) {
        const reason = selectHeadlineReason(attention[0]!.attention)!;
        return describeMachineReasonPhrase(attention[0]!.name, reason);
    }
    return t('machineAttention.fleet.count', { count: attention.length });
}

/**
 * The sentence under the fleet title: only how the others online are. The title counts or names the machines
 * that need a look and the Needs-you rows beneath name each with its reason, so the sentence never names them again.
 */
export function describeFleetDescription(input: Readonly<{ subjects: readonly MachineAttentionSubject[]; reportingCount: number; onlineCount: number; nowMs: number }>): string | null {
    if (input.reportingCount === 0) return null;
    const attention = selectAttentionSubjects(input.subjects);
    const calmOnline = Math.max(0, input.onlineCount - attention.length);
    if (calmOnline === 0) return null;
    return attention.length === 0
        ? t('machineAttention.fleet.allOnlineCalm', { count: calmOnline })
        : t('machineAttention.fleet.otherOnlineCalm', { count: calmOnline });
}

/** What the guard did, as one line ("Guard freed 410 MB on edge-1"). */
export function describeAutomaticAction(action: MachineResourceAutomaticActionV1, machineName: string): string {
    if (action.facts.freedBytes !== undefined) {
        return t('machineAttention.guard.freed', { machine: machineName, amount: formatHappierDataBytes(action.facts.freedBytes, { kind: 'memory' }) });
    }
    switch (action.kind) {
        case 'stopped_session': return t('machineAttention.guard.stoppedSession', { machine: machineName });
        case 'closed_browser': return t('machineAttention.guard.closedBrowser', { machine: machineName });
        case 'stopped_service': return t('machineAttention.guard.stoppedService', { machine: machineName });
        case 'stopped_left_behind': return t('machineAttention.guard.stoppedLeftBehind', { machine: machineName });
    }
}

/**
 * The rail icon's tooltip and accessible name after "Machines" (R4): the machine and its reason when one
 * needs you or is worth a look, a count when several need you, what the guard did, else presence.
 */
export function describeMachinesRailTooltip(input: Readonly<{
    /** How many machines need you now. */
    needsYouCount: number;
    /** The one machine named: the one that needs you, or the one worth a look. */
    subject: MachineAttentionSubject | null;
    guard: Readonly<{ action: MachineResourceAutomaticActionV1; machineName: string }> | null;
    presence: string | null;
}>): string | null {
    if (input.needsYouCount > 1) return t('machineAttention.rail.needYouCount', { count: input.needsYouCount });
    if (input.subject) {
        const reason = selectHeadlineReason(input.subject.attention);
        if (reason) return describeMachineReasonPhrase(input.subject.name, reason);
    }
    if (input.guard) return describeAutomaticAction(input.guard.action, input.guard.machineName);
    return input.presence;
}

/**
 * A machine's sentence under its name (R2): "Short on memory. Swapping for 6 min. 2 sessions working."
 * The lead is toned only when the machine needs a look; a calm machine reads "Calm. 3 sessions working."
 * `null` when the machine publishes no resources (the header keeps its description).
 */
export function describeMachineSentence(input: Readonly<{
    attention: MachineResourceAttentionV1 | null;
    working: number;
    nowMs: number;
    /** "71 GB free of 128", when the held summary knows it. */
    memoryFact?: string | null;
    online?: boolean;
    /** The existing presence owner supplies the offline/last-seen line. */
    offlineLine?: string;
}>): Readonly<{ lead: string; rest: string; tone: MachineAttentionTone }> | null {
    if (input.online === false) return { lead: input.offlineLine ?? t('machineDetailPage.offline'), rest: '', tone: 'calm' };
    if (!input.attention) return null;
    const work = input.working > 0 ? t('machineAttention.machine.working', { count: input.working }) : t('machineAttention.machine.idle');
    const reason = selectHeadlineReason(input.attention);
    if (!reason || input.attention.level === 'calm') {
        const rest = input.memoryFact ? t('machineAttention.machine.calmWithMemory', { work, memory: input.memoryFact }) : work;
        return { lead: t('machineAttention.machine.calmLead'), rest, tone: 'calm' };
    }
    return {
        lead: t('machineAttention.machine.lead', { word: describeMachineAttentionWord(reason) }),
        rest: t('machineAttention.sentences', { first: describeMachineReasonDetail(reason, input.nowMs), second: work }),
        tone: input.attention.level === 'needs_you' ? 'needs_you' : 'look',
    };
}
