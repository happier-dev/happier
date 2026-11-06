import type { IconName } from '@/components/ui/icons/Icon';
import { getLanguageDisplayNameForCode } from '@/constants/Languages';
import { getPreferredLanguage, t } from '@/text';
import type { VoiceRoleReadiness } from '@/voice/registry/readiness';
import type { VoiceSettingsPipeline, VoiceSettingsPipelineStep } from '@/voice/settings/projectVoiceSettingsPipeline';

import type { VoiceReadinessTone } from './VoiceReadinessGlyph';
import { resolveVoiceProviderReadinessPresentation } from '../panels/voiceProviderReadinessPresentation';

/** Resolves the dynamic keys a readiness fact carries (its reason and recovery action). */
type Translate = (key: string, params?: { service: string }) => string;

export type VoicePipelineStepPresentation = Readonly<{
    key: string;
    roleLabel: string;
    roles: VoiceSettingsPipelineStep['roles'];
    engine: VoiceSettingsPipelineStep['engine'];
    name: string;
    where: string;
    whereIcon: IconName;
    readiness: Readonly<{
        tone: Exclude<VoiceReadinessTone, 'ready' | 'unknown'>;
        message: string;
        recoveryAction: VoiceRoleReadiness['recoveryAction'] | null;
        actionLabel: string | null;
        progress: number | null;
    }> | null;
}>;

export type VoicePipelinePresentation = Readonly<{
    tone: VoiceReadinessTone;
    statusWord: string;
    steps: readonly VoicePipelineStepPresentation[];
    /** A readiness fact that belongs to the whole service rather than one step, said once under the steps. */
    card: VoicePipelineStepPresentation['readiness'];
}>;

function roleLabel(role: VoiceSettingsPipelineStep['roles'][number]): string {
    switch (role) {
        case 'hear': return t('settingsVoice.pages.pipeline.hear');
        case 'think': return t('settingsVoice.pages.pipeline.think');
        case 'speak': return t('settingsVoice.pages.pipeline.speak');
        case 'write':
        default: return t('settingsVoice.pages.pipeline.write');
    }
}

/**
 * How one role's readiness reads. Waiting on something outside the person's hands (a computer
 * offline, a feature its Home owner controls) is `waiting`; a real install is the working cell;
 * anything the person can fix needs them — but only for what they chose: an option they have not
 * chosen (`chosen: false`, a gallery tile or an engine row) that still needs setup reads quietly,
 * `needs_setup`, on every page. Unknown is not ready and not a failure: it has not been checked.
 */
export function resolveVoiceReadinessTone(
    readiness: VoiceRoleReadiness | null,
    options?: Readonly<{ chosen?: boolean }>,
): VoiceReadinessTone | null {
    const tone = resolveReadinessFactTone(readiness);
    return tone === 'needs_you' && options?.chosen === false ? 'needs_setup' : tone;
}

function resolveReadinessFactTone(readiness: VoiceRoleReadiness | null): VoiceReadinessTone | null {
    if (!readiness) return null;
    switch (readiness.status) {
        case 'ready':
            return 'ready';
        case 'installing':
            return 'working';
        case 'unavailable':
            // Withdrawn Machine presence has an explicit Retry through the Home
            // reader; it is not an unobserved service prerequisite to hide.
            if (readiness.code.startsWith('execution_machine_')) return 'waiting';
            if (readiness.code.endsWith('_unknown')) return 'unknown';
            return readiness.code === 'server_feature_disabled'
                ? 'waiting'
                : 'needs_you';
        case 'incompatible':
            return readiness.code.startsWith('execution_machine_') ? 'waiting' : 'blocked';
        case 'needs_setup':
        default:
            return readiness.code.startsWith('execution_machine_') ? 'waiting' : 'needs_you';
    }
}

function resolveWhere(step: VoiceSettingsPipelineStep): Readonly<{ text: string; icon: IconName }> {
    switch (step.placement.kind) {
        case 'machine':
            return {
                text: step.placement.machineName
                    ? t('settingsVoice.pages.pipeline.onMachine', { machine: step.placement.machineName })
                    : t('settingsVoice.pages.pipeline.onVoiceComputer'),
                icon: 'desktop',
            };
        case 'cloud':
            return { text: t('settingsVoice.pages.pipeline.inTheCloud'), icon: 'cloud' };
        case 'session':
            return { text: t('settingsVoice.pages.pipeline.inTheSession'), icon: 'chat-circle' };
        case 'message':
            // The hub says which language text is written in; the Dictation page sets it right below.
            if (step.placement.language === undefined) {
                return { text: t('settingsVoice.pages.pipeline.intoYourMessage'), icon: 'chat' };
            }
            return {
                text: t('settingsVoice.pages.pipeline.messageLanguage', {
                    language: step.placement.language
                        // A base tag ("fr") is named like a full one ("fr-FR"): by the language owner.
                        ? getLanguageDisplayNameForCode(step.placement.language, getPreferredLanguage())
                        : t('settingsVoice.pages.pipeline.languageAutomatic'),
                }),
                icon: 'translate',
            };
        case 'this_device':
        default:
            return { text: t('settingsVoice.pages.pipeline.onThisDevice'), icon: 'laptop' };
    }
}

function presentReadiness(readiness: VoiceRoleReadiness, translate: Translate, progress: number | null, service: string): VoicePipelineStepPresentation['readiness'] {
    const tone = resolveVoiceReadinessTone(readiness);
    if (!tone || tone === 'ready' || tone === 'unknown') return null;
    const copy = resolveVoiceProviderReadinessPresentation(readiness, translate, service);
    return {
        tone,
        message: copy.summary,
        recoveryAction: readiness.recoveryAction === 'none' ? null : readiness.recoveryAction,
        actionLabel: copy.action,
        progress: tone === 'working' ? progress : null,
    };
}

export function presentVoicePipeline(
    pipeline: VoiceSettingsPipeline,
    translate: Translate,
    cardReadiness: VoiceRoleReadiness | null = null,
    serviceTitle?: string,
): VoicePipelinePresentation {
    const steps = pipeline.steps.map((step, index): VoicePipelineStepPresentation => {
        const where = resolveWhere(step);
        const progress = step.progress && step.progress.total > 0
            ? Math.max(0, Math.min(1, step.progress.done / step.progress.total))
            : null;
        return {
            key: `${index}:${step.roles.join('-')}`,
            roleLabel: step.roles.map(roleLabel).join(' · '),
            roles: step.roles,
            engine: step.engine,
            name: step.engine.title,
            where: where.text,
            whereIcon: where.icon,
            readiness: step.readiness ? presentReadiness(step.readiness, translate, progress, step.engine.title) : null,
        };
    });
    const serviceFact = cardReadiness ? presentReadiness(cardReadiness, translate, null, serviceTitle ?? pipeline.steps[0]?.engine.title ?? t('voicePresence.title')) : null;
    // One message per state: a step that already says the service's fact keeps it, the card line is not repeated.
    const card = serviceFact && steps.some((step) => step.readiness?.message === serviceFact.message
        && step.readiness.recoveryAction === serviceFact.recoveryAction) ? null : serviceFact;
    const needYou = steps.filter((step) => step.readiness?.tone === 'needs_you' || step.readiness?.tone === 'blocked').length;
    const overall = resolveVoiceReadinessTone(cardReadiness ?? pipeline.readiness);
    const tone: VoiceReadinessTone = steps.some(step => step.readiness?.tone === 'blocked') || overall === 'blocked'
        ? 'blocked' : needYou > 0 ? 'needs_you' : overall ?? 'unknown';
    const statusWord = serviceFact
        ? serviceFact.tone === 'needs_you' || serviceFact.tone === 'blocked'
            ? t('settingsVoice.pages.pipeline.needsYou')
            : serviceFact.tone === 'working'
                ? t('settingsVoice.pages.pipeline.working')
                : t('settingsVoice.pages.pipeline.waiting')
        : needYou > 1
        ? t('settingsVoice.pages.pipeline.stepsNeedYou', { count: needYou })
        : needYou === 1
            ? t('settingsVoice.pages.pipeline.oneStepNeedsYou')
            : overall === 'ready'
                ? t('settingsVoice.pages.pipeline.ready')
                : overall === 'working'
                    ? t('settingsVoice.pages.pipeline.working')
                    : overall === 'waiting'
                        ? t('settingsVoice.pages.pipeline.waiting')
                        : t('settingsVoice.pages.pipeline.notChecked');
    return { tone, statusWord, steps, card };
}
