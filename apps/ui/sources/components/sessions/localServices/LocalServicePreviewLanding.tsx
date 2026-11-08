import * as React from 'react';
import { Linking, Platform } from 'react-native';
import { router } from 'expo-router';

import { useAuth } from '@/auth/context/AuthContext';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import {
    requestLocalServicePublicPreviewAdmission,
    type LocalServicePublicPreviewAdmission,
} from '@/sync/domains/local/services/publicPreview/admission';
import { resolveWebServerEntrySignInRoute } from '@/sync/domains/server/url/bootstrapActiveServerFromWebLocation';
import { t } from '@/text';

type LandingState = Readonly<{ kind: 'opening' }> | Exclude<LocalServicePublicPreviewAdmission, { kind: 'admitted' }>;

function openAdmissionUrl(url: string): void {
    // The admission URL is one-use; replacing the landing keeps it out of history.
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.location.replace(url);
    else void Linking.openURL(url);
}

/**
 * The link a people share hands out. Signed in, the Home decides once whether this Account is in
 * the share's audience and returns a one-use URL; the preview's own origin turns it into the
 * viewer cookie. Signed out, it asks the person to sign in first.
 */
export function LocalServicePreviewLanding(props: Readonly<{ exposureId: string }>): React.ReactElement {
    const { isAuthenticated } = useAuth();
    const [state, setState] = React.useState<LandingState>({ kind: 'opening' });
    const [attempt, setAttempt] = React.useState(0);

    React.useEffect(() => {
        if (!isAuthenticated) return;
        let current = true;
        setState({ kind: 'opening' });
        void requestLocalServicePublicPreviewAdmission(props.exposureId).then((result) => {
            if (!current) return;
            if (result.kind === 'admitted') openAdmissionUrl(result.admissionUrl);
            else setState(result);
        });
        return () => { current = false; };
    }, [attempt, isAuthenticated, props.exposureId]);

    const title = t('localServices.publicPreview.landing.title');
    const testID = 'local-service-preview-landing';
    // A link opened in a fresh tab has no history behind it: a dead end still leads into Happier.
    const openHappier = (state: string) => ({ label: t('localServices.publicPreview.landing.openHappier'),
        testID: `${testID}-${state}-open-happier`, onPress: () => router.replace('/' as never) });
    if (!isAuthenticated) {
        return <ItemList><SurfaceStateCard testID={`${testID}-sign-in`} kind="denied" title={title}
            reason={t('localServices.publicPreview.landing.signIn')}
            // Signing in is the one way forward here, so it is the filled primary even on a denied card.
            action={{ label: t('localServices.publicPreview.landing.signInCta'), testID: `${testID}-sign-in-cta`, invitation: true,
                onPress: () => router.replace(resolveWebServerEntrySignInRoute() as never) }} /></ItemList>;
    }
    switch (state.kind) {
        case 'opening':
            return <ItemList><SurfaceStateCard testID={`${testID}-opening`} kind="loading" title={title}
                reason={t('localServices.publicPreview.landing.opening')} /></ItemList>;
        case 'no_access':
            return <ItemList><SurfaceStateCard testID={`${testID}-no-access`} kind="denied" title={title}
                reason={t('localServices.publicPreview.landing.noAccess')} action={openHappier('no-access')} /></ItemList>;
        case 'ended':
            return <ItemList><SurfaceStateCard testID={`${testID}-ended`} kind="unavailable" title={title}
                reason={t('localServices.publicPreview.landing.ended')} action={openHappier('ended')} /></ItemList>;
        case 'unavailable':
            return <ItemList><SurfaceStateCard testID={`${testID}-unavailable`} kind="error" title={title}
                reason={t('localServices.publicPreview.landing.unavailable')}
                action={{ label: t('common.retry'), testID: `${testID}-retry`,
                    onPress: () => setAttempt((value) => value + 1) }} /></ItemList>;
    }
}
