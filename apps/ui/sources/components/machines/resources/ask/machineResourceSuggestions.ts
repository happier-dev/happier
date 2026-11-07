import type { MachineResourceSummaryV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

import { WEEKLY_STORAGE_REVIEW_PROMPT } from '@/components/automations/storage/weeklyStorageReviewTemplate';
import type { HomeComposerSuggestionPlacement } from '@/components/hub/composer/suggestions/homeComposerSuggestions';
import { t } from '@/text';

export type MachineResourceSuggestionMachine = HomeComposerSuggestionPlacement & Readonly<{ serverId: string; name: string }>;
export type MachineResourceSuggestionKind = 'memory' | 'disk' | 'storage' | 'leftBehind' | 'guard' | 'overview'
    | 'processes' | 'weeklyReview' | 'lastReport' | 'lastStorageReport' | 'notifyWhenBack'
    | 'setupDocker' | 'setupReview' | 'setupHarden' | 'securityAccess' | 'securityNetwork' | 'securityUpdates';

/** What the open tab is about: its Ask block suggests that subject (the resource tabs share resource prompts). */
export type MachineResourceSuggestionSubject = 'resources' | 'setup' | 'security';
const SUBJECT_PROMPTS = {
    setup: ['setupDocker', 'setupReview', 'setupHarden'],
    security: ['securityAccess', 'securityNetwork', 'securityUpdates'],
} as const satisfies Record<Exclude<MachineResourceSuggestionSubject, 'resources'>, readonly MachineResourceSuggestionKind[]>;

/** Each prompt's glyph says what it asks about (lab `ra` A1): ink only, one family, never a type tint. */
export const MACHINE_RESOURCE_SUGGESTION_ICON = {
    memory: 'cpu', disk: 'hard-drives', storage: 'hard-drives', leftBehind: 'stop-circle', guard: 'shield',
    overview: 'pulse', processes: 'chart-line', weeklyReview: 'calendar', lastReport: 'clock',
    lastStorageReport: 'hard-drives', notifyWhenBack: 'bell',
    setupDocker: 'cube', setupReview: 'list-checks', setupHarden: 'lock', securityAccess: 'users', securityNetwork: 'globe',
    securityUpdates: 'arrow-circle-up',
} as const satisfies Record<MachineResourceSuggestionKind, string>;

export type MachineResourceComposerSuggestion = Readonly<{
    id: string;
    source: 'machineResources';
    kind: MachineResourceSuggestionKind;
    machine: MachineResourceSuggestionMachine;
    title: string;
    reason: string;
    intent?: 'automation';
    fill: Readonly<{ text: string; placement: HomeComposerSuggestionPlacement | null }>;
}>;

/** Facts from the existing tab/store owners. Severity is already decided by the vitals owner. */
export type MachineResourceSuggestionFacts = Readonly<{
    machine: MachineResourceSuggestionMachine;
    online: boolean;
    /** A resource sample retained by this app session, not just a daemon publication. */
    hasLastReport?: boolean;
    memoryPressure?: MachineResourceSummaryV1['memory']['pressure'];
    disk?: Readonly<Pick<MachineResourceSummaryV1['disk'], 'availableBytes' | 'totalBytes' | 'tone'>>;
    happierStorageBytes?: number | null;
    leftBehindCount?: number | null;
    guardEnabled?: boolean | null;
    /** The canonical attention owner explicitly reported calm; absence never claims calm. */
    calm?: boolean;
    automationsEnabled?: boolean;
    /** The open tab's subject; resource tabs when absent. */
    subject?: MachineResourceSuggestionSubject;
}>;

/** Three current-report prompts online; offline, only prompts backed by retained reports. No side effects. */
export function deriveMachineResourceSuggestions(
    facts: MachineResourceSuggestionFacts,
    previous?: readonly MachineResourceComposerSuggestion[],
): readonly MachineResourceComposerSuggestion[] {
    // Compare the complete three-slot output, after priority and formatting. Raw facts can change
    // without changing a shown prompt; machine placement, language and fill intent still invalidate it.
    const retain = (next: readonly MachineResourceComposerSuggestion[]) =>
        previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
    const machine = facts.machine;
    const placement: HomeComposerSuggestionPlacement | null = facts.online
        ? { serverId: machine.serverId, machineId: machine.machineId, directory: machine.directory }
        : null;
    const make = (kind: MachineResourceSuggestionKind, title: string, reason: string, text = title): MachineResourceComposerSuggestion => ({
        id: `machineResources:${machine.serverId ?? ''}:${machine.machineId}:${kind}`,
        source: 'machineResources', kind, machine, title, reason,
        ...(kind === 'weeklyReview' ? { intent: 'automation' as const } : {}),
        fill: { text, placement: kind === 'weeklyReview' ? null : placement },
    });
    if (!facts.online) {
        // The block's description already says the machine is offline: its tiles do not repeat the cause.
        const reason = '';
        const notifyTitle = t('machineResources.askSuggestions.prompts.notifyWhenBack', { machine: machine.name });
        return retain([
            ...(facts.hasLastReport ? [make('lastReport', t('machineResources.askSuggestions.prompts.lastReport', { machine: machine.name }), reason)] : []),
            ...(facts.happierStorageBytes != null ? [make('lastStorageReport', t('machineResources.askSuggestions.prompts.lastStorageReport', { machine: machine.name }), reason)] : []),
            make('notifyWhenBack', notifyTitle, reason,
                `${notifyTitle}. ${t('machineResources.askSuggestions.prompts.notifyWhenBackConsent', { machine: machine.name })}\nsettings.set ${JSON.stringify({ anchor: 'notifications.machineOffline', key: machine.machineId, value: true })}`),
        ]);
    }

    if (facts.subject === 'setup' || facts.subject === 'security') {
        const reason = t(`machineResources.askSuggestions.reasons.${facts.subject}`);
        return retain(SUBJECT_PROMPTS[facts.subject].map(kind =>
            make(kind, t(`machineResources.askSuggestions.prompts.${kind}`, { machine: machine.name }), reason)));
    }

    const suggestions: MachineResourceComposerSuggestion[] = [];
    if (facts.memoryPressure === 'critical' || facts.memoryPressure === 'elevated') {
        suggestions.push(make('memory', t('machineResources.askSuggestions.prompts.memory', { machine: machine.name }),
            t('machineResources.askSuggestions.reasons.memory')));
    }
    if (facts.disk && facts.disk.tone !== 'calm' && facts.disk.availableBytes !== null) {
        suggestions.push(make('disk', t('machineResources.askSuggestions.prompts.disk', { machine: machine.name }),
            t('machineResources.askSuggestions.reasons.disk', { amount: formatHappierDataBytes(facts.disk.availableBytes, { kind: 'storage' }) })));
    }
    if (facts.leftBehindCount != null && facts.leftBehindCount > 0) {
        suggestions.push(make('leftBehind', t('machineResources.askSuggestions.prompts.leftBehind', { machine: machine.name }),
            t('machineResources.askSuggestions.reasons.leftBehind', { count: facts.leftBehindCount })));
    }
    if (facts.guardEnabled === false) {
        suggestions.push(make('guard', t('machineResources.askSuggestions.prompts.guard', { machine: machine.name }),
            t('machineResources.askSuggestions.reasons.guard')));
    }
    if (facts.happierStorageBytes != null && facts.happierStorageBytes > 0) {
        suggestions.push(make('storage', t('machineResources.askSuggestions.prompts.storage', { machine: machine.name }),
            t('machineResources.askSuggestions.reasons.storage', { amount: formatHappierDataBytes(facts.happierStorageBytes, { kind: 'storage' }) })));
    }
    if (facts.automationsEnabled) {
        suggestions.push(make('weeklyReview', t('machineResources.askSuggestions.prompts.weeklyReview'),
            t('machineResources.askSuggestions.reasons.weeklyReview'), WEEKLY_STORAGE_REVIEW_PROMPT));
    }
    const reason = t(facts.calm ? 'machineResources.askSuggestions.reasons.calm' : 'machineResources.askSuggestions.reasons.currentReport');
    suggestions.push(make('overview', t('machineResources.askSuggestions.prompts.overview', { machine: machine.name }), reason));
    if (!suggestions.some((suggestion) => suggestion.kind === 'storage')) {
        suggestions.push(make('storage', t('machineResources.askSuggestions.prompts.storage', { machine: machine.name }), reason));
    }
    suggestions.push(make('processes', t('machineResources.askSuggestions.prompts.processes', { machine: machine.name }), reason));
    // The Ask block has three suggestion slots (AGW-11); this is presentation, not a cleanup-set limit.
    return retain(suggestions.slice(0, 3));
}
