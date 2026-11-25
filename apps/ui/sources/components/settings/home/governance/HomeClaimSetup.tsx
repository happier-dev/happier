import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
    HOME_CLAIM_CODE_COMMAND_ARGUMENT_V1,
    HomeOwnerClaimCommandOutputV1Schema,
    normalizeHomeClaimCodeV1,
} from '@happier-dev/protocol/home/governance';

import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { useLocalRelayRuntimeControl } from '@/components/settings/server/localControl/useLocalRelayRuntimeControl';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    findPersonalHomeBootstrapCompletedProfile,
    getServerProfileById,
    listServerProfiles,
} from '@/sync/domains/server/serverProfiles';
import { refreshHomeGovernanceSnapshot } from '@/sync/engine/home/governance/homeGovernanceEngine';
import { claimHomeWithCode } from '@/sync/ops/home/homeGovernanceOperations';
import { t } from '@/text';

import { homeGovernanceFailureNotice } from './homeGovernanceLabels';

/** The deployment-local command that prints a one-time claim code. */
const PRINT_CLAIM_CODE_COMMAND = `happier-server ${HOME_CLAIM_CODE_COMMAND_ARGUMENT_V1}`;

type HomeClaimSetupProps = Readonly<{
    scope: ServerAccountScope;
    homeName: string;
    requestApproval?: (registration: ActionApprovalRegistration) => void;
    /** The system-task runner; the platform default unless a caller supplies one. */
    runner?: SystemTaskRunner;
}>;

function origin(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

/**
 * Whether this device completed the managed bootstrap of exactly this Home, the one Personal Home
 * a desktop can host. Only then is the local runtime worth asking about.
 */
function isThisDevicesPersonalHome(serverId: string): boolean {
    const profile = getServerProfileById(serverId);
    return profile !== null && findPersonalHomeBootstrapCompletedProfile(listServerProfiles())?.id === profile.id;
}

const HomeClaimEmptyState = React.memo(function HomeClaimEmptyState() {
    return (
        <ItemGroup>
            <EmptyState
                testID="home-claim-empty"
                layout="centered"
                iconName="key"
                title={t('homeGovernance.claim.emptyTitle')}
                subtitle={t('homeGovernance.claim.emptyBody')}
            />
        </ItemGroup>
    );
});

/**
 * Claim with a one-time code (lab `hcClaim-N/-C/-X`): ① the command that prints it, ② the paste
 * field. Claim stays disabled until the text can be a code, and every refusal reads the same so a
 * wrong code learns nothing.
 */
const HomeClaimWithCode = React.memo(function HomeClaimWithCode(props: HomeClaimSetupProps) {
    const { scope, requestApproval } = props;
    const [code, setCode] = React.useState('');
    const [refused, setRefused] = React.useState(false);
    const [claiming, setClaiming] = React.useState(false);
    const inFlightRef = React.useRef(false);
    const normalized = normalizeHomeClaimCodeV1(code);

    const changeCode = React.useCallback((text: string) => {
        setCode(text);
        setRefused(false);
    }, []);

    const claim = React.useCallback(async () => {
        if (!normalized || inFlightRef.current) return;
        inFlightRef.current = true;
        setClaiming(true);
        setRefused(false);
        try {
            // On success the Home was re-read by the operation: this page becomes the owner's console.
            const outcome = await claimHomeWithCode({ scope, code: normalized });
            if (outcome.kind === 'succeeded') return;
            if (outcome.kind === 'approval_pending') {
                requestApproval?.(outcome.artifactId);
                return;
            }
            if (outcome.failure.code === 'home_claim_refused') {
                setRefused(true);
                return;
            }
            const notice = homeGovernanceFailureNotice(outcome.failure);
            await Modal.alertAsync(notice.title, notice.body);
        } finally {
            inFlightRef.current = false;
            setClaiming(false);
        }
    }, [normalized, requestApproval, scope]);

    return (
        <>
            <HomeClaimEmptyState />
            <ItemGroup
                title={t('homeGovernance.claim.codeTitle')}
                description={t('homeGovernance.claim.codeDescription')}
            >
                <Item
                    testID="home-claim-print"
                    title={t('homeGovernance.claim.printStep')}
                    accessoryLayout="stacked"
                    showChevron={false}
                    rightElement={(
                        // The CLI command block every setup surface uses: monospace, read-only, with Copy; one line that scrolls on a phone.
                        <CodeBlockView
                            code={PRINT_CLAIM_CODE_COMMAND}
                            language="bash"
                            showHeaderRow={false}
                            showCopyButton
                            scrollTestID="home-claim-command"
                        />
                    )}
                />
                <Item
                    testID="home-claim-paste"
                    title={t('homeGovernance.claim.pasteStep')}
                    accessoryLayout="stacked"
                    showChevron={false}
                    rightElement={(
                        <View style={styles.inlineRow}>
                            <View style={styles.grow}>
                                <FieldTextInput
                                    testID="home-claim-code-input"
                                    accessibilityLabel={t('homeGovernance.claim.codeLabel')}
                                    value={code}
                                    onChangeText={changeCode}
                                    placeholder={t('homeGovernance.claim.codePlaceholder')}
                                    autoCapitalize="characters"
                                    monospace
                                    editable={!claiming}
                                    returnKeyType="go"
                                    onSubmitEditing={() => { void claim(); }}
                                    error={refused ? t('homeGovernance.claim.refused') : null}
                                />
                            </View>
                            <RoundButton
                                testID="home-claim-submit"
                                size="small"
                                title={t('homeGovernance.claim.claim')}
                                loading={claiming}
                                disabled={normalized === null || claiming}
                                onPress={() => { void claim(); }}
                            />
                        </View>
                    )}
                />
            </ItemGroup>
        </>
    );
});

/**
 * The hosting desktop (lab `hcClaim-D`): the owner is made here, through the deployment-local
 * claim this computer runs as a system task. Shown only when the local runtime answers that it
 * hosts this very Personal Home; until then, and anywhere else, the code claim is the way.
 */
const HostedPersonalHomeClaim = React.memo(function HostedPersonalHomeClaim(props: HomeClaimSetupProps) {
    const { scope } = props;
    const control = useLocalRelayRuntimeControl({ runner: props.runner, actionScope: scope, onApprovalPending: props.requestApproval });
    const [claiming, setClaiming] = React.useState(false);
    const [notice, setNotice] = React.useState<string | null>(null);
    const profile = getServerProfileById(scope.serverId);
    const purpose = control.status?.purpose;
    const hostsThisHome = !control.isUnavailable
        && purpose?.kind === 'personal-home'
        && origin(purpose.canonicalServerUrl) !== null
        && origin(purpose.canonicalServerUrl) === origin(profile?.canonicalServerUrl ?? profile?.serverUrl);

    const makeOwner = React.useCallback(async () => {
        setClaiming(true);
        setNotice(null);
        try {
            const outcome = await control.claimOwner(scope.accountId);
            const answer = outcome.status === 'completed'
                ? HomeOwnerClaimCommandOutputV1Schema.safeParse(outcome.result.data)
                : null;
            switch (answer?.success ? answer.data.result.status : undefined) {
                case 'claimed': break;
                case 'already_owned': setNotice(t('homeGovernance.claim.hostAlreadyOwned')); break;
                case 'target_inactive': setNotice(t('homeGovernance.claim.hostAccountInactive')); break;
                case 'target_not_found': setNotice(t('homeGovernance.errorAccountNotFound')); break;
                default: setNotice(t('homeGovernance.claim.hostFailed')); break;
            }
            // Whatever the command answered (claimed, or someone already owns it), the Home says who owns it now.
            await refreshHomeGovernanceSnapshot(scope);
        } finally {
            setClaiming(false);
        }
    }, [control, scope]);

    if (!hostsThisHome) return <HomeClaimWithCode {...props} />;

    return (
        <>
            <AttentionBanner
                testID="home-claim-host"
                tone="neutral"
                title={t('homeGovernance.claim.hostTitle', { home: props.homeName })}
                description={notice ?? t('homeGovernance.claim.hostBody')}
                accessibilityLiveRegion={notice ? 'assertive' : undefined}
                action={notice ? undefined : {
                    label: t('homeGovernance.claim.makeOwner'),
                    onPress: () => { void makeOwner(); },
                    loading: claiming,
                    disabled: claiming,
                    testID: 'home-claim-host-make-owner',
                }}
            />
            <HomeClaimEmptyState />
        </>
    );
});

/**
 * An ownerless Home (plan `2026-09-26-home-owner-console` §3.5, decision A): the desktop that hosts
 * this Personal Home makes the viewer its owner in one step; everywhere else the viewer claims it
 * with a one-time code printed on the server. No other claim path is offered.
 */
export const HomeClaimSetup = React.memo(function HomeClaimSetup(props: HomeClaimSetupProps) {
    return isThisDevicesPersonalHome(props.scope.serverId)
        ? <HostedPersonalHomeClaim {...props} />
        : <HomeClaimWithCode {...props} />;
});

const styles = StyleSheet.create(() => ({
    inlineRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    grow: {
        flex: 1,
        minWidth: 0,
    },
}));
