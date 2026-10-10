import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { validateServerConfigText } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import type {
    HomeReachabilityV1,
    HomeSettingEntryV1,
    HomeSettingsProjectionV1,
} from '@happier-dev/protocol/home/governance';

import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { LocalRelayAccessControlSection } from '@/components/settings/server/localControl/LocalRelayAccessControlSection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useHomeSettingsWithCompanion } from '@/hooks/home/useHomeSettingsWithCompanion';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { Modal } from '@/modal';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    getHomeReachability,
    readHomeSettingsInvalidFailure,
    setHomeIrohMode,
    setHomeSettings,
} from '@/sync/ops/home/homeGovernanceOperations';
import { findPersonalHomeBootstrapCompletedProfile, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

import { useHomeRuntimeExecutor, type HomeRuntimeExecutor } from '../runtime/homeRuntimeExecutor';
import { HomeDeploymentFixedNote } from './HomeDeploymentFixedNote';
import { HomeAdministrationSection } from './HomeAdministrationSection';
import type { HomeAdministrationContext } from './homeAdministrationContext';
import { homeAdministrationPoliciesPath } from './homeAdministrationRoutes';
import { homeGovernanceFailureNotice } from './homeGovernanceLabels';
import { HOME_REACH_SETTINGS } from './homeReachSettings';
import {
    hostAccessMethodLabel,
    publicAddressCaption,
    reachAddressHost,
    reachCanRetireIroh,
    reachWrappableHost,
    resolveReachExposure,
    type ReachExposure,
} from './homeReachPresentation';

const PUBLIC_ADDRESS_KEY = SERVER_CONFIG.HAPPIER_PUBLIC_SERVER_URL.key;
const WEBAPP_KEY = SERVER_CONFIG.HAPPIER_WEBAPP_URL.key;
const RELAY_POLICY_KEY = SERVER_CONFIG.HAPPIER_IROH_RELAY_POLICY.key;
const RELAY_URLS_KEY = SERVER_CONFIG.HAPPIER_IROH_RELAY_URLS.key;

const readReachability = (scope: ServerAccountScope) => getHomeReachability({ scope });

function entryFor(settings: HomeSettingsProjectionV1 | null, key: string): HomeSettingEntryV1 | undefined {
    return settings?.entries.find((entry) => entry.key === key);
}

/** The short caption under the address in the diagram (lab `hcReach-B`): where the address comes from. */
function diagramAddressCaption(reach: HomeReachabilityV1): string {
    switch (reach.publicAddress.source) {
        case 'deployment':
            return t('homeGovernance.reach.diagramDeployment');
        case 'home':
            return t('homeGovernance.reach.diagramHere');
        case 'inferred': {
            const method = reach.publicAddress.inferredFrom === 'tailscale_serve'
                ? t('homeGovernance.reach.methodTailscaleServe')
                : reach.publicAddress.inferredFrom === 'tailscale_funnel'
                    ? t('homeGovernance.reach.methodTailscaleFunnel')
                    : reach.hostAccess
                        ? hostAccessMethodLabel(reach.hostAccess.method)
                        : null;
            return method ? t('homeGovernance.reach.diagramInferred', { method }) : t('homeGovernance.reach.inferredFromHost');
        }
        case 'none':
            return '';
    }
}

function webAppCaption(reach: HomeReachabilityV1): string | undefined {
    switch (reach.webApp.source) {
        case 'deployment':
            return undefined;
        case 'home':
            return t('homeGovernance.reach.webAppDescription');
        case 'public_address':
            return t('homeGovernance.reach.webAppServed');
        case 'default':
            return t('homeGovernance.reach.webAppDefault');
    }
}

function irohStateCaption(reach: HomeReachabilityV1): string {
    if (reach.iroh.availability === 'not_available') return t('homeGovernance.reach.irohNotAvailable');
    if (reach.iroh.mode === 'disabled') return t('homeGovernance.reach.irohOff');
    switch (reach.iroh.state) {
        case 'active':
            return t('homeGovernance.reach.irohActive');
        case 'starting':
        case 'not_composed':
            return t('homeGovernance.reach.irohStarting');
        case 'stopping':
        case 'retired':
            return t('homeGovernance.reach.irohOff');
        case 'unavailable':
        case 'failed':
            return t('homeGovernance.reach.irohFailed');
    }
}

function hostingMachineLabel(executor: HomeRuntimeExecutor): string {
    switch (executor.kind) {
        case 'hosting_desktop':
            return t('homeGovernance.reach.thisComputer');
        case 'remote_host':
        case 'connected_machine':
            return executor.hostName;
        case 'elsewhere':
            return executor.hostName ?? t('homeGovernance.reach.homeServer');
        case 'deployment':
            return t('homeGovernance.reach.homeServer');
    }
}

/**
 * Reach B (lab `hcReach-B`): how a new device reaches this Home, drawn from the same facts as the
 * rows below — devices → the public address → the server, plus direct connections when on.
 */
const ReachPathDiagram = React.memo(function ReachPathDiagram(props: Readonly<{
    reach: HomeReachabilityV1;
    homeName: string;
    machineLabel: string;
    addressCaption: string;
}>) {
    const { theme } = useUnistyles();
    const { reach } = props;
    const host = reachAddressHost(reach.publicAddress.url);
    const direct = reach.iroh.availability === 'available' && reach.iroh.mode === 'enabled';
    const arrow = <Icon name="arrow-right" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />;
    return (
        <ItemGroup title={t('homeGovernance.reach.diagramTitle', { home: props.homeName })}>
            <SectionContentRow>
                <View testID="home-reach-diagram" style={styles.diagram} accessibilityRole="summary">
                    <View testID="home-reach-diagram-devices" style={styles.node}>
                        <Icon name="device-mobile" color={theme.colors.text.secondary} />
                        <Text style={[Typography.rowMeta(), styles.center, { color: theme.colors.text.primary }]}>{t('homeGovernance.reach.yourDevices')}</Text>
                    </View>
                    {arrow}
                    <View testID="home-reach-diagram-address-node" style={[styles.node, styles.addressNode]}>
                        <Icon name="globe" color={theme.colors.text.secondary} />
                        <Text testID="home-reach-diagram-address" style={[Typography.rowTitle(), styles.center, { color: theme.colors.text.primary }]}>
                            {host ? reachWrappableHost(host) : t('homeGovernance.reach.noAddress')}
                        </Text>
                        <Text style={[Typography.rowMeta(), styles.center, { color: theme.colors.text.secondary }]}>{props.addressCaption}</Text>
                    </View>
                    {arrow}
                    <View testID="home-reach-diagram-server" style={styles.node}>
                        <Icon name="laptop" color={theme.colors.text.secondary} />
                        <Text style={[Typography.rowTitle(), styles.center, { color: theme.colors.text.primary }]}>{props.machineLabel}</Text>
                        <Text style={[Typography.rowMeta(), styles.center, { color: theme.colors.text.secondary }]}>
                            {direct ? t('homeGovernance.reach.plusDirect') : t('homeGovernance.reach.noDirect')}
                        </Text>
                    </View>
                </View>
            </SectionContentRow>
        </ItemGroup>
    );
});

/**
 * One address setting: the effective value with where it comes from, and — for an owner, unless the
 * deployment fixed it — Change, which opens an inline field. Saving an empty field clears the stored
 * value, so the address falls back to inference or the default.
 */
const AddressRow = React.memo(function AddressRow(props: Readonly<{
    testID: string;
    setting: SettingRef;
    title: string;
    caption: string | undefined;
    /** The env key when the deployment fixed this address. */
    fixedKey?: string;
    value: string | null;
    entry: HomeSettingEntryV1 | undefined;
    canEdit: boolean;
    disabled: boolean;
    onSave: (entry: HomeSettingEntryV1, text: string) => Promise<string | null>;
}>) {
    const { theme } = useUnistyles();
    const [editing, setEditing] = React.useState(false);
    const [text, setText] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const [saving, setSaving] = React.useState(false);
    const { entry, onSave } = props;
    const editable = props.canEdit && entry !== undefined && !entry.fixed && entry.editable === 'home';

    const open = React.useCallback(() => {
        setText(typeof entry?.value === 'string' ? entry.value : '');
        setError(null);
        setEditing(true);
    }, [entry]);
    const save = React.useCallback(async () => {
        if (!entry) return;
        setSaving(true);
        try {
            const failure = await onSave(entry, text);
            if (failure) setError(failure);
            else setEditing(false);
        } finally {
            setSaving(false);
        }
    }, [entry, onSave, text]);

    if (editing && entry) {
        return (
            <SettingAnchor setting={props.setting}>
                <Item
                    title={props.title}
                    subtitle={props.caption}
                    subtitleAccessory={props.fixedKey ? <HomeDeploymentFixedNote keys={[props.fixedKey]} testID={props.testID} /> : undefined}
                    accessoryLayout="stacked"
                    showChevron={false}
                    rightElement={(
                        <View style={styles.editor}>
                            <FieldTextInput
                                testID={`${props.testID}-input`}
                                accessibilityLabel={props.title}
                                value={text}
                                placeholder="https://"
                                autoCapitalize="none"
                                keyboardType="url"
                                editable={!saving}
                                error={error}
                                onChangeText={(next) => {
                                    setText(next);
                                    setError(null);
                                }}
                                onSubmitEditing={() => { void save(); }}
                                style={styles.grow}
                            />
                            <RoundButton testID={`${props.testID}-cancel`} size="small" display="inverted" title={t('common.cancel')} disabled={saving} onPress={() => setEditing(false)} />
                            <RoundButton testID={`${props.testID}-save`} size="small" title={t('common.save')} loading={saving} disabled={props.disabled} onPress={() => { void save(); }} />
                        </View>
                    )}
                />
            </SettingAnchor>
        );
    }
    return (
        <SettingAnchor setting={props.setting}>
            <Item
                testID={props.testID}
                title={props.title}
                subtitle={props.caption}
                subtitleAccessory={props.fixedKey ? <HomeDeploymentFixedNote keys={[props.fixedKey]} testID={props.testID} /> : undefined}
                subtitleLines={0}
                showChevron={false}
                // A host can be long: on a narrow row the value and Change move under the label.
                accessoryLayout="adaptive"
                rightElement={(
                    <View style={styles.addressValue}>
                        {props.value ? (
                            <Text
                                testID={`${props.testID}-value`}
                                selectable
                                numberOfLines={1}
                                style={[Typography.rowMeta(), styles.addressText, { color: theme.colors.text.secondary }]}
                            >
                                {reachAddressHost(props.value)}
                            </Text>
                        ) : null}
                        {editable ? (
                            <RoundButton
                                testID={`${props.testID}-change`}
                                size="small"
                                display="inverted"
                                title={props.value ? t('homeGovernance.reach.change') : t('homeGovernance.reach.setAddress')}
                                disabled={props.disabled}
                                onPress={open}
                            />
                        ) : null}
                    </View>
                )}
            />
        </SettingAnchor>
    );
});

/** The consequence banner (§3.2): what reaching this Home from the internet means for sign-up. */
const ExposureBanner = React.memo(function ExposureBanner(props: Readonly<{
    exposure: ReachExposure;
    onOpenPolicies: () => void;
}>) {
    const { exposure } = props;
    if (exposure.kind === 'none') return null;
    const title = exposure.kind === 'internet'
        ? t('homeGovernance.reach.exposureInternetTitle', { method: hostAccessMethodLabel(exposure.method) })
        : t('homeGovernance.reach.exposureAddressTitle');
    const description = exposure.strangersCanSignUp
        ? t('homeGovernance.reach.exposureOpenSignup')
        : t('homeGovernance.reach.exposureInvitationOnly');
    return (
        <AttentionBanner
            testID={`home-reach-exposure:${exposure.kind}`}
            tone={exposure.strangersCanSignUp ? 'warning' : 'neutral'}
            title={title}
            description={description}
            action={{ label: t('homeGovernance.policies'), onPress: props.onOpenPolicies }}
        />
    );
});

const ReachPage = React.memo(function ReachPage(props: Readonly<{ context: HomeAdministrationContext }>) {
    const { context } = props;
    const router = useRouter();
    const { capabilities } = context.projection;
    const canView = capabilities.viewAdministration;
    const isOwner = capabilities.manageHomeSettings;
    const reads = useHomeSettingsWithCompanion(context.scope, canView, readReachability);
    const features = useServerFeaturesSnapshotForServerId(context.scope.serverId, { enabled: canView });
    const executor = useHomeRuntimeExecutor(
        context.scope.serverId,
        features.status === 'ready' ? features.features.capabilities.serverRelease?.flavor ?? null : null,
    );
    const [irohBusy, setIrohBusy] = React.useState(false);
    const disabled = !context.mutationsAvailable || !isOwner;

    const wasPendingRef = React.useRef(context.approvalPending);
    const { reload } = reads;
    React.useEffect(() => {
        if (wasPendingRef.current && !context.approvalPending) reload();
        wasPendingRef.current = context.approvalPending;
    }, [context.approvalPending, reload]);

    const writeSetting = React.useCallback(async (key: string, value: unknown): Promise<string | null> => {
        if (!reads.settings) return null;
        const outcome = await setHomeSettings({
            scope: context.scope,
            expectedRevision: reads.settings.revision,
            values: { [key]: value },
        });
        if (outcome.kind === 'succeeded') {
            reads.adoptSettings(outcome.value);
            return null;
        }
        if (outcome.kind === 'approval_pending') {
            context.requestApproval?.(outcome.artifactId);
            return null;
        }
        if (outcome.failure.code === 'home_settings_revision_conflict') {
            reads.reload();
            return t('homeGovernance.reach.conflict');
        }
        const invalid = readHomeSettingsInvalidFailure(outcome.failure);
        if (invalid) return invalid.reason === 'out_of_bounds' ? t('homeGovernance.reach.httpsRequired') : t('homeGovernance.reach.invalidAddress');
        return homeGovernanceFailureNotice(outcome.failure).body;
    }, [context, reads]);

    const saveAddress = React.useCallback(async (entry: HomeSettingEntryV1, text: string): Promise<string | null> => {
        const trimmed = text.trim();
        if (!trimmed) return await writeSetting(entry.key, null);
        const registryEntry = entry.key === PUBLIC_ADDRESS_KEY ? SERVER_CONFIG.HAPPIER_PUBLIC_SERVER_URL : SERVER_CONFIG.HAPPIER_WEBAPP_URL;
        const validated = validateServerConfigText(registryEntry, trimmed);
        if (!validated.ok) return validated.reason === 'out_of_bounds' ? t('homeGovernance.reach.httpsRequired') : t('homeGovernance.reach.invalidAddress');
        return await writeSetting(entry.key, validated.value);
    }, [writeSetting]);

    const setIroh = React.useCallback(async (enabled: boolean) => {
        if (!enabled) {
            const confirmed = await Modal.confirm(
                t('homeGovernance.reach.irohOffTitle'),
                t('homeGovernance.reach.irohOffBody'),
                { cancelText: t('common.cancel'), confirmText: t('homeGovernance.reach.irohOffConfirm'), destructive: true },
            );
            if (!confirmed) return;
        }
        setIrohBusy(true);
        try {
            const outcome = await setHomeIrohMode({ scope: context.scope, mode: enabled ? 'enabled' : 'disabled' });
            if (outcome.kind === 'succeeded') {
                reads.adoptCompanion(outcome.value);
                return;
            }
            if (outcome.kind === 'approval_pending') {
                context.requestApproval?.(outcome.artifactId);
                return;
            }
            const notice = outcome.failure.code === 'home_iroh_needs_public_address'
                ? { title: t('homeGovernance.reach.irohNeedsAddressTitle'), body: t('homeGovernance.reach.irohNeedsAddressBody') }
                : homeGovernanceFailureNotice(outcome.failure);
            await Modal.alertAsync(notice.title, notice.body);
            reads.reload();
        } finally {
            setIrohBusy(false);
        }
    }, [context, reads]);

    if (!canView) {
        return (
            <ItemGroup description={t('homeGovernance.forbiddenBody')}>
                <Item testID="home-reach-forbidden" title={t('homeGovernance.forbiddenTitle')} mode="info" showChevron={false} />
            </ItemGroup>
        );
    }
    const reach = reads.companion;
    if (!reach || !reads.settings) {
        if (reads.failure || reads.companionFailure) {
            return (
                <ItemGroup description={t('homeGovernance.reach.loadFailed')}>
                    <Item testID="home-reach-retry" title={t('homeGovernance.retry')} onPress={reads.reload} showChevron={false} />
                </ItemGroup>
            );
        }
        return (
            <ItemGroup>
                <Item testID="home-reach-loading" title={t('homeGovernance.loading')} loading mode="info" showChevron={false} />
            </ItemGroup>
        );
    }

    const publicEntry = entryFor(reads.settings, PUBLIC_ADDRESS_KEY);
    const webAppEntry = entryFor(reads.settings, WEBAPP_KEY);
    const relayEntry = entryFor(reads.settings, RELAY_POLICY_KEY);
    const relayUrlsEntry = entryFor(reads.settings, RELAY_URLS_KEY);
    const addressCaption = publicAddressCaption(reach);
    const exposure = resolveReachExposure(reach, context.projection);
    const irohAvailable = reach.iroh.availability === 'available';
    const irohOn = reach.iroh.mode === 'enabled';
    const irohLocked = !isOwner || reach.iroh.modeFixed || !irohAvailable;
    const cannotRetire = irohOn && !reachCanRetireIroh(reach);
    const relayCustomCount = Array.isArray(relayUrlsEntry?.value) ? relayUrlsEntry.value.length : 0;
    const relayPolicy = relayEntry?.value === 'disabled' ? 'disabled' : 'automatic';
    const relayPending = relayEntry?.applied?.pending === true;
    const locallyHosted = executor.kind === 'hosting_desktop' ? findPersonalHomeBootstrapCompletedProfile(listServerProfiles()) : null;
    const readFailure = reads.failure ?? reads.companionFailure;

    return (
        <>
            {readFailure ? (
                <SurfaceFreshnessLine
                    testID="home-reach-refresh-error"
                    tone="warning"
                    reason={homeGovernanceFailureNotice(readFailure, { effect: 'read' }).body}
                    busy={reads.loading || reads.companionLoading}
                    action={{ label: t('homeGovernance.retry'), onPress: reads.reload }}
                />
            ) : null}
            <ExposureBanner exposure={exposure} onOpenPolicies={() => router.push(homeAdministrationPoliciesPath(context.scope.serverId))} />
            <ReachPathDiagram
                reach={reach}
                homeName={context.homeName}
                machineLabel={hostingMachineLabel(executor)}
                addressCaption={diagramAddressCaption(reach)}
            />

            <ItemGroup title={t('homeGovernance.reach.addresses')} description={t('homeGovernance.reach.addressesDescription')}>
                <AddressRow
                    testID="home-reach-public-address"
                    setting={HOME_REACH_SETTINGS.settings.publicAddress}
                    title={t('homeGovernance.reach.publicAddress')}
                    caption={addressCaption}
                    fixedKey={reach.publicAddress.source === 'deployment' ? publicEntry?.key ?? PUBLIC_ADDRESS_KEY : undefined}
                    value={reach.publicAddress.url}
                    entry={publicEntry}
                    canEdit={isOwner}
                    disabled={disabled}
                    onSave={saveAddress}
                />
                <AddressRow
                    testID="home-reach-webapp"
                    setting={HOME_REACH_SETTINGS.settings.webAppAddress}
                    title={t('homeGovernance.reach.webAppAddress')}
                    caption={webAppCaption(reach)}
                    fixedKey={reach.webApp.source === 'deployment' ? webAppEntry?.key ?? WEBAPP_KEY : undefined}
                    value={reach.webApp.url}
                    entry={webAppEntry}
                    canEdit={isOwner}
                    disabled={disabled}
                    onSave={saveAddress}
                />
                <SettingAnchor setting={HOME_REACH_SETTINGS.settings.accessMethod}>
                    <Item
                        testID="home-reach-access-method"
                        title={t('homeGovernance.reach.accessMethod')}
                        subtitle={accessMethodCaption(executor)}
                        subtitleLines={0}
                        detail={reach.hostAccess ? hostAccessMethodLabel(reach.hostAccess.method) : undefined}
                        showChevron={executor.kind === 'remote_host'}
                        {...(executor.kind === 'remote_host'
                            ? { onPress: () => router.push(`/settings/remote-hosts/${encodeURIComponent(executor.host.id)}`) }
                            : { mode: 'info' as const })}
                    />
                </SettingAnchor>
            </ItemGroup>

            {executor.kind === 'hosting_desktop' && isOwner ? (
                <LocalRelayAccessControlSection upstreamUrl={locallyHosted?.serverUrl ?? null} />
            ) : null}

            <ItemGroup title={t('homeGovernance.reach.directConnections')} description={t('homeGovernance.reach.directConnectionsDescription')}>
                <SettingAnchor setting={HOME_REACH_SETTINGS.settings.directConnections}>
                    <Item
                        testID="home-reach-iroh"
                        title={t('homeGovernance.reach.directConnectionsRow')}
                        subtitle={reach.iroh.modeFixed
                            ? irohStateCaption(reach)
                            : cannotRetire && isOwner
                                ? `${irohStateCaption(reach)} · ${t('homeGovernance.reach.irohNeedsAddressHint')}`
                                : irohStateCaption(reach)}
                        subtitleLines={0}
                        subtitleAccessory={reach.iroh.modeFixed
                            ? <HomeDeploymentFixedNote keys={[SERVER_CONFIG.HAPPIER_HOME_IROH_MODE.key]} testID="home-reach-iroh" />
                            : undefined}
                        showChevron={false}
                        mode={irohAvailable ? undefined : 'info'}
                        rightElement={irohAvailable ? (
                            <Switch
                                testID="home-reach-iroh-switch"
                                value={irohOn}
                                disabled={irohLocked || irohBusy || !context.mutationsAvailable || cannotRetire}
                                onValueChange={(next) => { void setIroh(next); }}
                            />
                        ) : undefined}
                    />
                </SettingAnchor>
                {irohAvailable && relayEntry ? (
                    <SettingAnchor setting={HOME_REACH_SETTINGS.settings.relay}>
                        <Item
                            testID="home-reach-relay"
                            title={t('homeGovernance.reach.relay')}
                            subtitle={relayEntry.fixed
                                ? undefined
                                : relayPending
                                    ? t('homeGovernance.reach.appliesAfterRestartPending')
                                    : relayCustomCount > 0
                                        ? t('homeGovernance.reach.relayCustom', { count: relayCustomCount })
                                        : t('homeGovernance.reach.appliesAfterRestart')}
                            subtitleLines={0}
                            subtitleAccessory={relayEntry.fixed ? <HomeDeploymentFixedNote keys={[relayEntry.key]} testID="home-reach-relay" /> : undefined}
                            accessoryLayout="adaptive"
                            showChevron={false}
                            rightElement={isOwner && !relayEntry.fixed ? (
                                <SegmentedTabBar<'automatic' | 'disabled'>
                                    role="radiogroup"
                                    testIDPrefix="home-reach-relay-policy"
                                    tabs={[
                                        { id: 'automatic', label: t('homeGovernance.reach.relayAutomatic') },
                                        { id: 'disabled', label: t('homeGovernance.reach.relayOff') },
                                    ]}
                                    activeTabId={relayPolicy}
                                    onSelectTab={(tabId) => {
                                        if (tabId !== relayPolicy && !disabled) void writeSetting(RELAY_POLICY_KEY, tabId);
                                    }}
                                    disabled={disabled}
                                    slidingThumb
                                    segmentSizing="content"
                                />
                            ) : undefined}
                            detail={isOwner && !relayEntry.fixed ? undefined : relayPolicy === 'disabled' ? t('homeGovernance.reach.relayOff') : t('homeGovernance.reach.relayAutomatic')}
                        />
                    </SettingAnchor>
                ) : null}
            </ItemGroup>
        </>
    );
});

function accessMethodCaption(executor: HomeRuntimeExecutor): string {
    switch (executor.kind) {
        case 'hosting_desktop':
            return t('homeGovernance.reach.accessMethodHere');
        case 'remote_host':
            return t('homeGovernance.reach.accessMethodRemoteHost', { host: executor.hostName });
        case 'connected_machine':
        case 'elsewhere':
            return executor.hostName
                ? t('homeGovernance.reach.accessMethodElsewhereNamed', { host: executor.hostName })
                : t('homeGovernance.reach.accessMethodElsewhere');
        case 'deployment':
            return t('homeGovernance.reach.accessMethodDeployment');
    }
}

/**
 * How this Home is reached (plan §3.2, decision B, lab `hcReach-B`): the path a new device takes,
 * the addresses with where each comes from, the host-side access method run by its executor, and
 * direct connections. Owners change what the Home owns; admins read; deployment values are locked.
 */
export const HomeAdministrationReachScreen = React.memo(function HomeAdministrationReachScreen(
    props: Readonly<{ serverId: string }>,
) {
    return (
        <HomeAdministrationSection
            serverId={props.serverId}
            title={t('homeGovernance.reach.title')}
            description={t('homeGovernance.pages.reach')}
        >
            {(context) => <ReachPage context={context} />}
        </HomeAdministrationSection>
    );
});

const styles = StyleSheet.create(() => ({
    diagram: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    node: {
        flex: 1,
        minWidth: 0,
        alignItems: 'center',
        gap: 4,
    },
    addressValue: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        flexShrink: 1,
    },
    addressText: {
        flexShrink: 1,
    },
    addressNode: {
        flex: 1.6,
    },
    center: {
        textAlign: 'center',
    },
    editor: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
    },
    grow: {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 200,
    },
}));
