import { t } from '@/text';

import { describeBackgroundServiceTargetMode } from '../describeBackgroundServiceTargetMode';

export type BackgroundServiceReplacementPromptServicePresentation = Readonly<{
    label: string;
    releaseChannel: string | null;
    targetMode: string | null;
    targetModeLabel: string;
    running: boolean;
    summary: string;
}>;

export type BackgroundServiceReplacementPromptPresentation = Readonly<{
    targetServerUrl: string | null;
    targetReleaseChannel: string | null;
    services: readonly BackgroundServiceReplacementPromptServicePresentation[];
}>;

export type BackgroundServiceReplacementPromptBodyFormat = 'compact' | 'detailed';

function normalizeText(raw: string | null | undefined): string | null {
    const value = String(raw ?? '').trim();
    return value.length > 0 ? value : null;
}

export function buildBackgroundServiceReplacementPromptPresentation(params: Readonly<{
    targetServerUrl?: string | null;
    targetReleaseChannel?: string | null;
    services?: ReadonlyArray<Readonly<{
        label?: string | null;
        releaseChannel?: string | null;
        targetMode?: string | null;
        running?: boolean | null;
    }>>;
}>): BackgroundServiceReplacementPromptPresentation {
    const services = (params.services ?? []).flatMap((service) => {
        const label = normalizeText(service.label);
        if (!label) {
            return [];
        }

        const releaseChannel = normalizeText(service.releaseChannel);
        const targetMode = normalizeText(service.targetMode);
        const targetModeLabel = describeBackgroundServiceTargetMode(targetMode);
        const details = [
            releaseChannel,
            targetModeLabel,
        ].filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).join(', ');

        return [{
            label,
            releaseChannel,
            targetMode,
            targetModeLabel,
            running: service.running === true,
            summary: details.length > 0 ? `${label} (${details})` : label,
        } satisfies BackgroundServiceReplacementPromptServicePresentation];
    });

    return {
        targetServerUrl: normalizeText(params.targetServerUrl),
        targetReleaseChannel: normalizeText(params.targetReleaseChannel),
        services,
    };
}

export function buildBackgroundServiceReplacementPromptBody(
    params: Readonly<{
        targetServerUrl?: string | null;
        targetReleaseChannel?: string | null;
        services?: ReadonlyArray<Readonly<{
            label?: string | null;
            releaseChannel?: string | null;
            targetMode?: string | null;
            running?: boolean | null;
        }>>;
        format?: BackgroundServiceReplacementPromptBodyFormat;
    }>,
): string | undefined {
    const format = params.format ?? 'compact';
    const presentation = buildBackgroundServiceReplacementPromptPresentation(params);
    const lines = format === 'detailed'
        ? [
            presentation.targetServerUrl
                ? `${t('machine.backgroundServicePrompt.targetServer')}: ${presentation.targetServerUrl}`
                : null,
            presentation.targetReleaseChannel
                ? `${t('machine.backgroundServicePrompt.targetReleaseChannel')}: ${presentation.targetReleaseChannel}`
                : null,
            presentation.services.length > 0 ? t('machine.backgroundServicePrompt.existingServices') : null,
            ...presentation.services.map((service) =>
                `- ${service.summary}${service.running ? ` — ${t('machine.backgroundServicePrompt.running')}` : ''}`),
        ]
        : [
            presentation.targetServerUrl,
            presentation.targetReleaseChannel,
            ...presentation.services.map((service) => service.summary),
        ];
    const filtered = lines.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    return filtered.length > 0 ? filtered.join('\n') : undefined;
}
