import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SystemTaskProgressCard } from '@/components/systemTasks/SystemTaskProgressCard';
import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { PersonalHomeBootstrapSnapshot } from '../bootstrap/personalHomeBootstrapTypes';
import { PersonalHomeExistingRuntimeDecision } from './PersonalHomeExistingRuntimeDecision';
import { PersonalHomeSetupFailure } from './PersonalHomeSetupFailure';
import { PersonalHomeSetupProgress } from './PersonalHomeSetupProgress';
import { personalHomeCopy } from './personalHomeCopy';

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.background.canvas },
    scrollContent: { flexGrow: 1, width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 32, paddingVertical: 36 },
    header: { gap: 12, marginBottom: 30 },
    mark: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.button.primary.background },
    title: { ...Typography.default('semiBold'), color: theme.colors.text.primary, fontSize: 30, lineHeight: 36, letterSpacing: -0.5 },
    status: { ...Typography.default(), color: theme.colors.text.secondary, fontSize: 15, lineHeight: 22 },
    rows: { gap: 10 },
    detailsButton: { alignSelf: 'flex-start', minHeight: 44, marginTop: 20, paddingHorizontal: 4, justifyContent: 'center' },
    detailsText: { ...Typography.default('semiBold'), color: theme.colors.text.secondary, fontSize: 14 },
    details: { marginTop: 8 },
}));

function phaseCopy(snapshot: PersonalHomeBootstrapSnapshot): string {
    switch (snapshot.phase) {
        case 'checking': return t('common.loading');
        case 'preparing-home': return personalHomeCopy('preparingHomeStatus', 'Getting your local Home ready.');
        case 'connecting-app': return personalHomeCopy('connectingAppStatus', 'Connecting Happier to your Home.');
        case 'closing-signup': return personalHomeCopy('closingSignupStatus', 'Securing your Home before it becomes available.');
        case 'preparing-computer': return personalHomeCopy('preparingComputerStatus', 'Your Home is ready. Preparing this computer in the background.');
        case 'blocked': return personalHomeCopy('blockedStatus', 'Setup needs your attention before we continue.');
        case 'ready': return personalHomeCopy('readyStatus', 'Your Home is ready.');
    }
}

export const PersonalHomeSetupSurface = React.memo(function PersonalHomeSetupSurface(props: Readonly<{
    snapshot: PersonalHomeBootstrapSnapshot;
    activeTask?: SystemTaskRunState | null;
    onRetry?: () => void;
    onOpenDetails?: () => void;
    onUseExisting?: () => void;
    onUseAnotherHome?: () => void;
}>) {
    const { theme } = useUnistyles();
    const [detailsOpen, setDetailsOpen] = React.useState(false);
    const hasFailure = props.snapshot.phase === 'blocked';
    const showExistingDecision = props.snapshot.action === 'choose-existing-runtime';
    const showDetails = detailsOpen && props.activeTask != null;
    return (
        <View style={styles.root} testID="personal-home-setup-surface">
            <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
                <View style={styles.header} accessibilityLiveRegion="polite">
                    <View style={styles.mark} accessibilityElementsHidden>
                        <Icon name="house" size={ICON_SIZE.lg} color={theme.colors.button.primary.tint} />
                    </View>
                    <Text style={styles.title} accessibilityRole="header">
                        {personalHomeCopy('title', t('setupOnboarding.screenTitle'))}
                    </Text>
                    <Text testID="personal-home-bootstrap-phase" accessibilityLiveRegion="polite" style={styles.status}>{phaseCopy(props.snapshot)}</Text>
                </View>

                <View style={styles.rows}>
                    <PersonalHomeSetupProgress rows={props.snapshot.rows} />
                </View>

                {showExistingDecision && props.onUseExisting && props.onUseAnotherHome ? (
                    <PersonalHomeExistingRuntimeDecision
                        onUseExisting={props.onUseExisting}
                        onUseAnotherHome={props.onUseAnotherHome}
                    />
                ) : null}

                {hasFailure ? (
                    <PersonalHomeSetupFailure
                        detail={props.snapshot.detail}
                        onRetry={props.snapshot.action === 'retry' ? props.onRetry : undefined}
                        onOpenDetails={props.onOpenDetails ?? (() => setDetailsOpen((value) => !value))}
                    />
                ) : null}

                {props.activeTask ? (
                    <Pressable
                        testID="personal-home-bootstrap-details-toggle"
                        accessibilityRole="button"
                        accessibilityLabel={t('common.details')}
                        accessibilityState={{ expanded: detailsOpen }}
                        onPress={() => setDetailsOpen((value) => !value)}
                        style={styles.detailsButton}
                    >
                        <Text style={styles.detailsText}>{detailsOpen ? t('common.collapse') : t('common.details')}</Text>
                    </Pressable>
                ) : null}
                {showDetails ? (
                    <View style={styles.details} testID="personal-home-bootstrap-details-panel">
                        <SystemTaskProgressCard snapshot={props.activeTask!} />
                    </View>
                ) : null}
            </ScrollView>
        </View>
    );
});
