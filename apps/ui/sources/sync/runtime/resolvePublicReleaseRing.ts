import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import {
    normalizePublicReleaseRingId,
    normalizeReleaseRingId,
    resolveCliInvokerNameForPublicRing,
    resolvePublicReleaseRingIdForAnyRingId,
    resolvePublicReleaseRingLabelForId,
    type PublicReleaseRingLabel,
} from '@happier-dev/release-runtime/releaseRings';

import { config } from '@/config';
import { resolveAppVariant } from '@/sync/runtime/appVariant';

export function resolvePreferredPublicReleaseRingIdForApp(params: Readonly<{
    variant: string | null | undefined;
    envAppEnv?: string;
    envExpoPublicAppEnv?: string;
}>): PublicReleaseRingId {
    const ringId = normalizeReleaseRingId(params.variant ?? '');
    if (ringId) {
        return resolvePublicReleaseRingIdForAnyRingId(ringId);
    }

    const envRingId =
        normalizePublicReleaseRingId(params.envAppEnv ?? '')
        || normalizePublicReleaseRingId(params.envExpoPublicAppEnv ?? '');
    if (envRingId) {
        return envRingId;
    }

    const appVariant = resolveAppVariant({
        appVariant: params.variant ?? undefined,
        envAppEnv: params.envAppEnv,
        envExpoPublicAppEnv: params.envExpoPublicAppEnv,
    }) ?? 'production';

    return appVariant === 'production' ? 'stable' : 'preview';
}

export function resolvePreferredPublicReleaseRingIdForCurrentApp(): PublicReleaseRingId {
    return resolvePreferredPublicReleaseRingIdForApp({
        variant: config.variant,
        envAppEnv: process.env.APP_ENV,
        envExpoPublicAppEnv: process.env.EXPO_PUBLIC_APP_ENV,
    });
}

export function resolvePreferredPublicReleaseRingLabelForApp(params: Readonly<{
    variant: string | null | undefined;
    envAppEnv?: string;
    envExpoPublicAppEnv?: string;
}>): PublicReleaseRingLabel {
    return resolvePublicReleaseRingLabelForId(resolvePreferredPublicReleaseRingIdForApp(params));
}

export function resolvePreferredPublicReleaseRingLabelForCurrentApp(): PublicReleaseRingLabel {
    return resolvePreferredPublicReleaseRingLabelForApp({
        variant: config.variant,
        envAppEnv: process.env.APP_ENV,
        envExpoPublicAppEnv: process.env.EXPO_PUBLIC_APP_ENV,
    });
}

export function resolveCliInvokerNameForCurrentApp(): 'happier' | 'hprev' | 'hdev' {
    return resolveCliInvokerNameForPublicRing(resolvePreferredPublicReleaseRingIdForCurrentApp());
}
