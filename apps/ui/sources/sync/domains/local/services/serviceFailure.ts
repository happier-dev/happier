import type { LocalServiceLaunchTarget } from './launch';
import { hasUncertainLocalServiceNativeCustodyV1, type LocalServiceEstablishmentFailureV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import { t } from '@/text';

export type LocalServiceOutputRecovery = Readonly<{
    kind: 'reviewOutput';
    label: string;
    lines: readonly string[];
}>;

/** The launcher feed owns sanitization and removes diagnostics on recovery. */
export function resolveLocalServiceOutput(
    target: Pick<LocalServiceLaunchTarget, 'diagnostics'> | null,
    establishmentFailure?: LocalServiceEstablishmentFailureV1,
): LocalServiceOutputRecovery | null {
    // A diagnostic can carry a whole stderr chunk; the output reads one printed line per line, each once.
    const lines = [...new Set([
        ...(target?.diagnostics ?? []).map(diagnostic => diagnostic.message?.trim() || diagnostic.code),
        ...(establishmentFailure?.lastStderrLine ? [establishmentFailure.lastStderrLine] : []),
    ].flatMap(text => text.split(/\r?\n/)).map(line => line.trimEnd()).filter(line => line.trim().length > 0))];
    return lines.length > 0 ? { kind: 'reviewOutput', label: t('localServices.row.reviewOutput'), lines } : null;
}

/** A current supervisor failure, never inferred from an absent endpoint or a preview refusal. */
export type LocalServiceStartFailure = Readonly<{
    reasonCode: 'plugin_managed_service_establishment_failed';
    serviceName: string;
    recovery: LocalServiceOutputRecovery | null;
}>;

export function resolveLocalServiceStartFailure(target: LocalServiceLaunchTarget): LocalServiceStartFailure | null {
    if (target.source !== 'managed_service' || target.state === 'stale' || target.serviceState !== 'failed'
        || hasUncertainLocalServiceNativeCustodyV1(target)) return null;
    return {
        reasonCode: 'plugin_managed_service_establishment_failed' as const,
        serviceName: target.title,
        recovery: resolveLocalServiceOutput(target),
    };
}
