import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { useOpenedTeamCredentialDisplayNames } from '@/components/settings/teams/credentials/teamCredentialPrivateLabels';
import { presentSessionTeamCredentialDenial } from '@/components/sessions/presentation/sessionTeamCredentialDenialPresentation';
import { useSessionModelPickerEntry } from '@/components/sessions/presentation/useSessionModelPickerEntry';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { readTeamCredentialResourceCatalogs, subscribeTeamsSnapshots } from '@/sync/store/teams/teamsSnapshots';
import { t } from '@/text';

export const TEAM_CREDENTIAL_DENIAL_RECOVERY_TEST_ID = 'transcript-event-runtime-issue-recovery';

/**
 * What a refused turn's historical notice adds to its shared display text: the credential's name when this
 * viewer's already-loaded Team catalog carries it, and the presenter's recovery. Choosing another credential
 * is the composer's own model picker, asked through the presentation-target registry; the row decides
 * nothing about who may change the model beyond the permission the transcript already reads.
 */
export function TeamCredentialDenialRecovery(props: Readonly<{
    issue: SessionRuntimeIssueV1;
    address: SessionAddress | null;
}>) {
    const source = useSessionTranscriptSource();
    const viewerScope = source.useAuthorship().viewerScope;
    const canSendMessages = source.useInteraction().canSendMessages === true;
    const picker = useSessionModelPickerEntry(props.address);
    const resourceId = props.issue.teamCredential?.resourceId ?? null;
    const accountId = viewerScope?.accountId ?? null;
    const scopeServerId = viewerScope ? resolveServerProfileScopeIdForIdentifier(viewerScope.serverId) : null;
    const scope = React.useMemo(() => accountId && scopeServerId ? { serverId: scopeServerId, accountId } : null,
        [accountId, scopeServerId]);
    const readResource = React.useCallback(() => resourceId && scope
        ? readTeamCredentialResourceCatalogs(scope).find((resource) => resource.id === resourceId) ?? null
        : null, [resourceId, scope]);
    const resource = React.useSyncExternalStore(subscribeTeamsSnapshots, readResource, readResource);
    const resources = React.useMemo(() => resource ? [resource] : [], [resource]);
    const openedNames = useOpenedTeamCredentialDisplayNames({ scope, resources });
    const credentialName = resourceId ? openedNames[resourceId] ?? null : null;
    const denial = presentSessionTeamCredentialDenial({ issue: props.issue, resolveResourceDisplayName: () => credentialName });
    if (!denial) return null;
    const unavailable = !picker.offered && !canSendMessages;
    if (!credentialName && !picker.offered && !unavailable) return null;
    return (
        <View style={styles.footer}>
            {credentialName ? <Text variant="meta" selectable style={styles.name}>{credentialName}</Text> : null}
            {picker.offered || unavailable ? (
                <RoundButton
                    testID={TEAM_CREDENTIAL_DENIAL_RECOVERY_TEST_ID}
                    size="small"
                    display="secondary"
                    title={denial.actionLabel}
                    disabled={unavailable}
                    accessibilityHint={unavailable ? t('session.sharing.noEditPermission') : undefined}
                    onPress={picker.open}
                    style={styles.action}
                />
            ) : null}
            {unavailable ? <Text variant="meta" style={styles.name}>{t('session.sharing.noEditPermission')}</Text> : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    footer: {
        gap: theme.space.s6,
        marginTop: theme.space.s2,
        alignItems: 'flex-start',
    },
    name: {
        color: theme.colors.text.tertiary,
    },
    action: {
        alignSelf: 'flex-start',
    },
}));
