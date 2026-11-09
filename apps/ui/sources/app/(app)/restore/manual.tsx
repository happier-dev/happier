import React from 'react';
import { Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { t } from '@/text';
import { AuthRouteStepFrame } from '@/components/onboarding/ui/AuthRouteStepFrame';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { SecretKeyLoginForm } from '@/components/account/restore/SecretKeyLoginForm';
import { admitInternalRouteHref, normalizeInternalReturnPath } from '@/utils/path/routeUtils';
import { resolveHomeAuthenticationTarget } from '@/auth/flows/resolveHomeAuthenticationTarget';
import { Text } from '@/components/ui/text/Text';
import { useAuth } from '@/auth/context/AuthContext';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import {
    buildApiTokenCreateResumePath,
    isApiTokenCreateResumeReturnPath,
    readApiTokenCreateResume,
} from '@/components/settings/apiTokens/apiTokenCreateResume';


export default function Restore() {
    const router = useRouter();
    const auth = useAuth();
    const params = useLocalSearchParams<{
        returnTo?: string | string[];
        resumeCreate?: string | string[];
        draft?: string | string[];
        targetServerId?: string | string[];
        targetServerUrl?: string | string[];
        expectedAccountId?: string | string[];
    }>();
    const rawReturnTo = Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo;
    const returnTo = normalizeInternalReturnPath(rawReturnTo) ?? null;
    // A token or embed create interrupted to restore encryption access resumes with its whole draft.
    const createResume = readApiTokenCreateResume(params);
    const targetServerId = String(Array.isArray(params.targetServerId)
        ? params.targetServerId[0] ?? ''
        : params.targetServerId ?? '').trim();
    const expectedAccountId = String(Array.isArray(params.expectedAccountId)
        ? params.expectedAccountId[0] ?? ''
        : params.expectedAccountId ?? '').trim();
    const targetServerUrl = String(Array.isArray(params.targetServerUrl)
        ? params.targetServerUrl[0] ?? ''
        : params.targetServerUrl ?? '').trim();
    const hasExactTargetRequest = targetServerId.length > 0
        || targetServerUrl.length > 0
        || expectedAccountId.length > 0;
    // A QR can name the Home before this device knows its Account. Account-bound
    // token repair still requires the captured Account as well as the Home.
    const requiresAccountTarget = isApiTokenCreateResumeReturnPath(returnTo);
    const resolvedTarget = targetServerId && targetServerUrl && (!requiresAccountTarget || expectedAccountId)
        ? resolveHomeAuthenticationTarget({ kind: 'saved_profile', profileRef: targetServerId })
        : null;
    const exactTarget = resolvedTarget
        && createServerUrlComparableKey(resolvedTarget.canonicalServerUrl) === createServerUrlComparableKey(targetServerUrl)
        ? resolvedTarget
        : null;
    const completedReturnTo = isApiTokenCreateResumeReturnPath(returnTo) && createResume && exactTarget
        ? buildApiTokenCreateResumePath(returnTo, createResume.draft, createResume.target)
        : returnTo;

    return (
        <AuthRouteStepFrame
            testID="restore-manual-wizard"
            title={t('setupOnboarding.authSecretKeyTitle')}
            subtitle={t('setupOnboarding.authSecretKeySubtitle')}
            onBack={() => safeRouterBack({ router, fallbackHref: '/restore' })}
        >
            <>
                {hasExactTargetRequest ? exactTarget ? (
                    <SecretKeyLoginForm
                        returnTo={completedReturnTo ?? '/'}
                        target={{ ...exactTarget, ...(expectedAccountId ? { expectedAccountId } : {}),
                            requireKeyChallengeV2: Boolean(expectedAccountId) }}
                        onAuthenticated={async () => {
                            const switched = await setActiveServerAndSwitch({
                                serverId: exactTarget.serverId,
                                scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
                                refreshAuth: auth.refreshFromActiveServer,
                            });
                            if (switched !== 'blocked') {
                                if (completedReturnTo) router.replace(admitInternalRouteHref(completedReturnTo));
                                else router.dismissTo('/');
                            }
                        }}
                    />
                ) : (
                    <Text testID="restore-manual-target-unavailable" accessibilityRole="alert">
                        {t('settingsAccount.nativePassword.serverUnavailable')}
                    </Text>
                ) : (
                    <SecretKeyLoginForm returnTo={completedReturnTo ?? '/'} onSuccess={completedReturnTo ? () => router.replace(admitInternalRouteHref(completedReturnTo)) : undefined} />
                )}
            </>
        </AuthRouteStepFrame>
    );
}
