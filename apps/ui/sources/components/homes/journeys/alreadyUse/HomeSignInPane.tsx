import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { HomeAuthenticationAction } from '@/auth/capabilities/authMethodCapabilities';
import { HomeAuthenticationFlow } from '@/components/account/auth/HomeAuthenticationFlow';
import { useExactSavedHomeAuthenticationCatalog } from '@/components/account/auth/useExactSavedHomeAuthenticationCatalog';
import { composeWelcomeEntryModel } from '@/components/onboarding/preAuth/composeWelcomeEntryModel';
import { WelcomeWayButton } from '@/components/onboarding/preAuth/WelcomeActionCard';
import { WelcomeEntryView } from '@/components/onboarding/preAuth/WelcomeEntryView';
import type { WelcomeActionAdmission } from '@/components/onboarding/preAuth/WelcomeActionList';
import { projectWelcomeEntryViewModel } from '@/components/onboarding/preAuth/welcomeEntryViewModel';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useHasCompletedAuthOnce, useLastSignInMethod } from '@/sync/domains/state/onboardingUiState';
import { isServerProfilePersonalHomeBootstrapCompleted, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { t } from '@/text';
import { useViewportClass } from '@/utils/platform/useViewportClass';

const NO_RETURNING_GREETING = { title: '', subtitle: '' };

/**
 * Path (c), second step: the Home answered and is saved on this device. It shows that Home's own
 * welcome — the one welcome decider (`composeWelcomeEntryModel`) and view (`WelcomeEntryView`) over
 * the methods read from that exact Home (`useExactSavedHomeAuthenticationCatalog`), never from the Home
 * in focus. A chosen way opens in the Home sign-in owner (`HomeAuthenticationFlow`).
 */
export function HomeSignInPane(props: Readonly<{
    profile: ServerProfile;
    onBack: () => void;
    onDone: () => void;
    /** `host`: the hosting page's back control returns to the previous pane, so the pane draws none. */
    backControl?: 'pane' | 'host';
}>) {
    const { theme } = useUnistyles();
    const { profile } = props;
    const catalog = useExactSavedHomeAuthenticationCatalog(profile);
    const label = resolveHomeDisplayLabel(profile, profile.id);
    const paneBack = props.backControl !== 'host';
    const compact = useViewportClass() === 'compact';
    const returning = useHasCompletedAuthOnce();
    const lastSignInMethodId = useLastSignInMethod();
    const [chosen, setChosen] = React.useState<HomeAuthenticationAction | null>(null);
    // "I already use Happier" opens the same Home's ways in (the welcome's restore context), not a second list.
    const [showWays, setShowWays] = React.useState(false);
    const target = React.useMemo(() => ({ kind: 'saved_profile' as const, profileRef: profile.id }), [profile.id]);
    const isPersonalHome = isServerProfilePersonalHomeBootstrapCompleted(profile);
    const serverAvailability = catalog.state === 'ready' ? 'ready' as const
        : catalog.state === 'loading' ? 'loading' as const
            : catalog.incompatible ? 'incompatible' as const : 'unavailable' as const;
    const model = composeWelcomeEntryModel({
        target: { kind: 'explicit_home', home: target, label },
        homeMethods: catalog.actions.map(({ method, action, execution }) => ({
            method, action, execution, authority: { purpose: 'home' as const, target }, intendedHome: target,
        })),
        catalogFirstLoad: catalog.state === 'loading',
        ...(profile.serverIdentityId ? { observedHomeServerIdentityId: profile.serverIdentityId } : {}),
        homePairingAvailable: true,
        context: { kind: showWays ? 'restore' : 'home' },
        // This step is one Home's own welcome: choosing another Home or service is the previous step.
        allowedNavigation: { changeHome: false, selectService: false, scanOrPasteHome: true, createPersonalHome: false },
        serviceCatalogState: { kind: 'not_offered' },
        userHistory: returning ? 'returning' : 'first_time',
        placement: { hasHome: true, canConnectDirectly: false, platform: compact ? 'phone' : 'computer', canScanQr: false, canShowQr: false },
        lastSignInMethodId,
    });
    const viewModel = projectWelcomeEntryViewModel(model, {
        options: {
            homeLabel: label,
            serverAvailability,
            showAuthActions: true,
            authenticationActions: catalog.actions,
            ...(isPersonalHome ? { isPersonalHome: true as const } : {}),
            retentionDisclosure: undefined,
            authEntryUnavailable: false,
        },
        place: { label: `${label} · ${toServerUrlDisplay(profile.canonicalServerUrl ?? profile.serverUrl)}` },
        showGreeting: true,
        terminalWaiting: false,
        returningGreeting: NO_RETURNING_GREETING,
        hasHome: true,
        serviceName: null,
        canRetryService: false,
        canChooseService: false,
    });
    const [pendingActionId, setPendingActionId] = React.useState<string | null>(null);
    const admission = React.useMemo<WelcomeActionAdmission>(() => ({
        pendingActionId,
        run: async (actionId, action) => {
            setPendingActionId(actionId);
            try { await action(); } finally { setPendingActionId(null); }
        },
    }), [pendingActionId]);
    const keyAction = catalog.actions.find((candidate) => candidate.execution.kind === 'key_entry');
    const leave = chosen ? () => setChosen(null) : showWays ? () => setShowWays(false) : props.onBack;
    const choose = (index: number) => {
        const action = model.actions[index]?.action;
        if (action?.kind === 'scan_or_paste_home') {
            setShowWays(true);
            return;
        }
        if (action?.kind !== 'authenticate') return;
        const request = action.request;
        const match = catalog.actions.find((candidate) => candidate.method.id === request.method.id
            && candidate.action.id === request.action.id && candidate.action.mode === request.action.mode);
        if (match) setChosen(match);
    };

    return (
        <View style={styles.pane} testID="already-use-happier.pane.home-sign-in">
            {paneBack ? (
                <HappierPressable testID="already-use-happier.another-way" accessibilityRole="button"
                    onPress={leave} style={styles.back}>
                    <Icon name="caret-left" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                    <Text style={styles.backText}>{t('homesJourneys.anotherWay')}</Text>
                </HappierPressable>
            ) : null}
            {chosen && catalog.state === 'ready' ? (
                <HomeAuthenticationFlow
                    target={target}
                    actions={[chosen]}
                    openChosenAction
                    transport={catalog.transport ?? undefined}
                    keyChallengeV2Available={catalog.keyChallengeV2Available}
                    homeLabel={label}
                    returnTo="/"
                    onAuthenticated={props.onDone}
                    onBack={() => setChosen(null)}
                    showBackAction={false}
                />
            ) : (
                <WelcomeEntryView model={viewModel} compact={compact} waysLeading={showWays && keyAction ? (
                    <WelcomeWayButton testID="welcome-home-key" iconName="key" title={t('welcome.continueWithKey')}
                        onPress={() => setChosen(keyAction)} />
                ) : undefined} interaction={{
                    admission,
                    getActionId: (index) => model.actions[index]?.id,
                    onAction: choose,
                    onNoticeAction: () => catalog.retry(),
                    onSelfHosting: () => {},
                }} />
            )}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    pane: {
        gap: 14,
    },
    back: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        alignSelf: 'flex-start',
        minHeight: 24,
    },
    backText: {
        ...Typography.variant('meta', 'medium'),
        color: theme.colors.text.secondary,
    },
}));
