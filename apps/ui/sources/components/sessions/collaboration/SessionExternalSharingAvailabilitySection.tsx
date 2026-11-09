import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { ExternalSessionSharingAvailability } from '@/components/sessions/external/sharing/useExternalSessionSharingAvailability';
import { t } from '@/text';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import type { ExactSessionSnapshotState } from './useExactSessionSnapshot';

/**
 * One truthful availability/action projection shared by named Access and
 * anonymous publication. It presents the existing external materialization
 * owner; it neither reconstructs progress nor starts a second workflow.
 */
export function SessionExternalSharingAvailabilitySection(props: Readonly<{
    snapshot: ExactSessionSnapshotState;
    availability: ExternalSessionSharingAvailability | null;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const { snapshot, availability } = props;

    if (snapshot.kind === 'loading') {
        return (
            <ItemGroup>
                <Item
                    testID="session-external-sharing-loading"
                    title={t('common.loading')}
                    loading
                    mode="info"
                    showChevron={false}
                />
            </ItemGroup>
        );
    }
    if (snapshot.kind === 'authorization_lost') {
        return (
            <ItemGroup>
                <Item
                    testID="session-external-sharing-authorization-lost"
                    title={t('errors.permissionDenied')}
                    subtitle={t('session.follow.accessLost')}
                    icon={<Icon name="lock" size={ICON_SIZE.lg} color={theme.colors.text.secondary} />}
                    mode="info"
                    showChevron={false}
                />
            </ItemGroup>
        );
    }
    if (snapshot.kind === 'unsupported') {
        return (
            <ItemGroup>
                <Item
                    testID="session-external-sharing-unsupported"
                    title={t('externalSessions.sharingTranscriptUnavailableTitle')}
                    subtitle={t('externalSessions.operationActionErrorUpgradeRequired')}
                    icon={<Icon name="cloud-slash" size={ICON_SIZE.lg} color={theme.colors.text.secondary} />}
                    mode="info"
                    showChevron={false}
                />
            </ItemGroup>
        );
    }
    if (snapshot.kind === 'unavailable' || !availability) {
        return (
            <ItemGroup>
                <Item
                    testID="session-external-sharing-retry"
                    title={t('errors.operationFailed')}
                    subtitle={t('common.retry')}
                    icon={<Icon name="warning-circle" size={ICON_SIZE.lg} color={theme.colors.state.warning.foreground} />}
                    onPress={snapshot.retry}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    const { sharingPresentation } = availability;
    if (sharingPresentation.state === 'hosted') return null;

    const machineName = sharingPresentation.machineName ?? t('status.unknown');
    if (sharingPresentation.state === 'requires_persisted_import') {
        const subtitle = availability.sourceMachineUnavailableReason
            ?? t('externalSessions.sharingTranscriptOnMachine', { machine: machineName });
        // A prerequisite, said once with its one action: where the transcript is, then the button that
        // brings it into Happier. The statement is information; only the button acts.
        return (
            <ItemGroup>
                <Item
                    testID="session-external-sharing-materialize-row"
                    title={subtitle}
                    titleLines={2}
                    icon={<Icon name="cloud-arrow-up" size={ICON_SIZE.lg} color={theme.colors.text.secondary} />}
                    mode="info"
                    showChevron={false}
                    bottomElementInset="text"
                    bottomElementOutsidePressable
                    bottomElement={<View style={styles.action}><RoundButton
                        testID="session-external-sharing-materialize"
                        size="small"
                        display="secondary"
                        title={t('externalSessions.operationTitleMaterialize')}
                        loading={availability.materializeInFlight}
                        disabled={availability.materializeInFlight || !availability.sourceMachineOnline}
                        onPress={availability.startMaterialization}
                        accessibilityLabel={`${t('externalSessions.operationTitleMaterialize')}. ${subtitle}`}
                    /></View>}
                />
            </ItemGroup>
        );
    }
    if (sharingPresentation.state === 'import_incomplete') {
        const title = availability.canResumePartialImport
            ? t('externalSessions.operationActionResume')
            : t('externalSessions.sharingImportIncomplete');
        const subtitle = availability.canResumePartialImport
            ? t('externalSessions.sharingImportIncomplete')
            : availability.sourceMachineUnavailableReason
                ?? t('externalSessions.sharingActionAwaitingAvailability');
        return (
            <ItemGroup>
                <Item
                    testID="session-external-sharing-resume"
                    title={title}
                    subtitle={subtitle}
                    icon={<Icon name="cloud-arrow-up" size={ICON_SIZE.lg} color={theme.colors.text.secondary} />}
                    loading={availability.resumeInFlight}
                    disabled={!availability.canResumePartialImport || availability.resumeInFlight}
                    onPress={availability.canResumePartialImport ? availability.resumePartialImport : undefined}
                    mode={availability.canResumePartialImport ? undefined : 'info'}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }
    if (sharingPresentation.state === 'shared_snapshot_stale') {
        const staleAt = sharingPresentation.materializedThroughSourceAt;
        return (
            <ItemGroup>
                {staleAt !== null ? (
                    <Item
                        testID="session-external-sharing-stale"
                        title={t('externalSessions.sharingSharedUpTo', {
                            time: formatShortRelativeTimeAt(staleAt, availability.sharingPresentationNowMs),
                        })}
                        icon={<Icon name="clock" size={ICON_SIZE.lg} color={theme.colors.text.secondary} />}
                        mode="info"
                        showChevron={false}
                    />
                ) : null}
                <Item
                    testID="session-external-sharing-update"
                    title={t('externalSessions.sharingUpdateSharedCopy')}
                    subtitle={availability.updateSharedCopySubtitle}
                    icon={<Icon name="arrow-clockwise" size={ICON_SIZE.lg} color={theme.colors.text.secondary} />}
                    loading={availability.materializeInFlight}
                    disabled={availability.materializeInFlight || !availability.sourceMachineOnline}
                    onPress={availability.startMaterialization}
                    showChevron={false}
                    accessibilityLabel={`${t('externalSessions.sharingUpdateSharedCopy')}. ${availability.updateSharedCopySubtitle}`}
                />
            </ItemGroup>
        );
    }
    return (
        <ItemGroup>
            <Item
                testID="session-external-sharing-transcript-unavailable"
                title={t('externalSessions.sharingTranscriptUnavailableTitle')}
                subtitle={t('externalSessions.sharingTranscriptUnavailable')}
                icon={<Icon name="cloud-slash" size={ICON_SIZE.lg} color={theme.colors.text.secondary} />}
                mode="info"
                showChevron={false}
            />
        </ItemGroup>
    );
}

const styles = StyleSheet.create((theme) => ({
    action: { flexDirection: 'row', paddingTop: theme.space.s8 },
}));
