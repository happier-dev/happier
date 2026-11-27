import * as React from 'react';
import { View } from 'react-native';
import { HappierMiddleEllipsisText } from '@happier-dev/plugin-ui/presentation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { validateServerConfigText } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import type {
    HomeReachabilityV1,
    HomeSettingEntryV1,
    HomeSettingsProjectionV1,
} from '@happier-dev/protocol/home/governance';

import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows, type ItemLoadState } from '@/components/ui/lists/ItemLoadStateRows';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useHomeSettingsWithCompanion } from '@/hooks/home/useHomeSettingsWithCompanion';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { readServerAccountScopeOwnerLifetime } from '@/sync/domains/scope/serverAccountScope';
import { Modal } from '@/modal';
import { homeReachabilityRead } from '@/sync/engine/home/governance/homeAdministrationReads';
import {
    setHomeIrohMode,
    setHomeSettings,
} from '@/sync/ops/home/homeGovernanceOperations';
import { t } from '@/text';

import { HomeRelayManageSection } from './HomeRelayManageSection';
import { HomeDeploymentFixedNote } from './HomeDeploymentFixedNote';
import { HomeSettingFieldRow, type HomeSettingStage } from './HomeSettingFieldRow';
import { buildHomeSettingWrite, type HomeSettingDraftValue } from './homeSettingDraft';
import { HomeAdministrationSection } from './HomeAdministrationSection';
import type { HomeAdministrationContext } from './homeAdministrationContext';
import { homeAdministrationPoliciesPath } from './homeAdministrationRoutes';
import { homeGovernanceFailureNotice, homeSettingsFieldFailure } from './homeGovernanceLabels';
import { HOME_REACH_SETTINGS } from './homeReachSettings';
import {
    hostAccessMethodLabel,
    publicAddressCaption,
    reachAddressHost,
    reachCanRetireIroh,
    resolveReachExposure,
    type ReachExposure,
} from './homeReachPresentation';

const PUBLIC_ADDRESS_KEY = SERVER_CONFIG.HAPPIER_PUBLIC_SERVER_URL.key;
const WEBAPP_KEY = SERVER_CONFIG.HAPPIER_WEBAPP_URL.key;
const PUBLIC_SUBPATH_KEY = SERVER_CONFIG.HAPPIER_PUBLIC_SHARES_ALLOW_SUBPATH.key;
const RELAY_POLICY_KEY = SERVER_CONFIG.HAPPIER_IROH_RELAY_POLICY.key;
const RELAY_URLS_KEY = SERVER_CONFIG.HAPPIER_IROH_RELAY_URLS.key;
const LOADING: ItemLoadState = Object.freeze({ kind: 'loading' as const });


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
                        <Text style={[Typography.variant('meta'), styles.center, { color: theme.colors.text.primary }]}>{t('homeGovernance.reach.yourDevices')}</Text>
                    </View>
                    {arrow}
                    <View testID="home-reach-diagram-address-node" style={[styles.node, styles.addressNode]}>
                        <Icon name="globe" color={theme.colors.text.secondary} />
                        {/* One line: a long address gives up its middle, never its port to a second line. */}
                        <HappierMiddleEllipsisText
                            testID="home-reach-diagram-address"
                            value={host ?? t('homeGovernance.reach.noAddress')}
                            style={[Typography.variant('label', 'semiBold'), styles.center, styles.addressLine, { color: theme.colors.text.primary }]}
                        />
                        <Text style={[Typography.variant('meta'), styles.center, { color: theme.colors.text.secondary }]}>{props.addressCaption}</Text>
                    </View>
                    {arrow}
                    <View testID="home-reach-diagram-server" style={styles.node}>
                        <Icon name="laptop" color={theme.colors.text.secondary} />
                        <Text style={[Typography.variant('label', 'semiBold'), styles.center, { color: theme.colors.text.primary }]}>{props.machineLabel}</Text>
                        <Text style={[Typography.variant('meta'), styles.center, { color: theme.colors.text.secondary }]}>
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
                                style={[Typography.variant('meta'), styles.addressText, { color: theme.colors.text.secondary }]}
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
    const reads = useHomeSettingsWithCompanion(context.scope, canView, homeReachabilityRead);
    const features = useServerFeaturesSnapshotForServerId(context.scope.serverId, { enabled: canView });
    const deploymentManaged = features.status === 'ready' && features.features.capabilities.serverRelease?.flavor === 'full';
    const [irohBusy, setIrohBusy] = React.useState(false);
    const [publicLinksBusy, setPublicLinksBusy] = React.useState(false);
    const [publicLinksFailure, setPublicLinksFailure] = React.useState<string | null>(null);
    const publicLinksInFlight = React.useRef(false);
    const disabled = !context.mutationsAvailable || !isOwner;

    const wasPendingRef = React.useRef(context.approvalPending);
    const { reload } = reads;
    React.useEffect(() => {
        if (wasPendingRef.current && !context.approvalPending) reload();
        wasPendingRef.current = context.approvalPending;
    }, [context.approvalPending, reload]);

    const writeSettings = React.useCallback(async (values: Readonly<Record<string, unknown>>): Promise<string | null> => {
        if (!reads.settings) return null;
        const outcome = await setHomeSettings({
            scope: context.scope,
            expectedRevision: reads.settings.revision,
            values,
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
        const invalid = homeSettingsFieldFailure(outcome.failure);
        if (invalid) return invalid.reason === 'out_of_bounds' ? t('homeGovernance.reach.httpsRequired') : t('homeGovernance.reach.invalidAddress');
        return homeGovernanceFailureNotice(outcome.failure).body;
    }, [context, reads]);
    const writeSetting = React.useCallback(
        async (key: string, value: unknown) => await writeSettings({ [key]: value }),
        [writeSettings],
    );

    // Custom relay servers save as each entry is left or removed, through the registry draft path.
    const [relayUrlsDraft, setRelayUrlsDraft] = React.useState<HomeSettingDraftValue | undefined>(undefined);
    const relayUrlsDraftRef = React.useRef<HomeSettingDraftValue | undefined>(undefined);
    const [relayUrlsFailure, setRelayUrlsFailure] = React.useState<string | null>(null);
    const stageRelayUrls: HomeSettingStage = React.useCallback((_key, next) => {
        relayUrlsDraftRef.current = next ?? undefined;
        setRelayUrlsDraft(next ?? undefined);
        setRelayUrlsFailure(null);
    }, []);
    const commitRelayUrls = React.useCallback((key: string) => {
        const staged = relayUrlsDraftRef.current;
        if (disabled || !staged || !reads.settings) return;
        const write = buildHomeSettingWrite(reads.settings.entries, { [key]: staged });
        // A refused entry is said under its own field; nothing is sent until every entry parses.
        if (!write.ok || !write.changed) return;
        void writeSettings(write.values).then((failure) => {
            setRelayUrlsFailure(failure);
            if (!failure) {
                relayUrlsDraftRef.current = undefined;
                setRelayUrlsDraft(undefined);
            }
        });
    }, [disabled, reads.settings, writeSettings]);

    const savePublicLinks: HomeSettingStage = React.useCallback((_key, next) => {
        const entry = entryFor(reads.settings, PUBLIC_SUBPATH_KEY);
        if (disabled || entry?.fixed || publicLinksInFlight.current || next?.kind !== 'value' || typeof next.value !== 'boolean') return;
        publicLinksInFlight.current = true;
        setPublicLinksBusy(true);
        setPublicLinksFailure(null);
        void writeSetting(PUBLIC_SUBPATH_KEY, next.value).then(setPublicLinksFailure).finally(() => {
            publicLinksInFlight.current = false;
            setPublicLinksBusy(false);
        });
    }, [disabled, reads.settings, writeSetting]);

    const saveAddress = React.useCallback(async (entry: HomeSettingEntryV1, text: string): Promise<string | null> => {
        const trimmed = text.trim();
        if (!trimmed) return await writeSetting(entry.key, null);
        const registryEntry = entry.key === PUBLIC_ADDRESS_KEY ? SERVER_CONFIG.HAPPIER_PUBLIC_SERVER_URL : SERVER_CONFIG.HAPPIER_WEBAPP_URL;
        const validated = validateServerConfigText(registryEntry, trimmed);
        if (!validated.ok) return validated.reason === 'out_of_bounds' ? t('homeGovernance.reach.httpsRequired') : t('homeGovernance.reach.invalidAddress');
        return await writeSetting(entry.key, validated.value);
    }, [writeSetting]);

    const setIroh = React.useCallback(async (enabled: boolean) => {
        const credential = context.credentialLifetime && readServerAccountScopeOwnerLifetime(context.credentialLifetime);
        setIrohBusy(true);
        try {
            const outcome = await setHomeIrohMode({ scope: context.scope, mode: enabled ? 'enabled' : 'disabled' });
            if (outcome.kind === 'succeeded') {
                if (credential?.isCurrent()) reads.adoptCompanion(outcome.value);
                return;
            }
            if (outcome.kind === 'approval_pending') {
                context.requestApproval?.(outcome.artifactId);
                return;
            }
            if (isActionApprovalDeclinedErrorCode(outcome.failure.code)) return;
            const notice = homeGovernanceFailureNotice(outcome.failure);
            await Modal.alertAsync(notice.title, notice.body);
            reads.reload();
        } finally {
            setIrohBusy(false);
        }
    }, [context, reads]);

    if (!canView) {
        return (
            <ItemGroup>
                <SurfaceStateCard testID="home-reach-forbidden" kind="denied" size="line"
                    title={t('homeGovernance.forbiddenTitle')} reason={t('homeGovernance.forbiddenBody')} />
            </ItemGroup>
        );
    }
    const reach = reads.companion;
    const failedReads = [reads.failure, reads.companionFailure].filter((failure) => failure !== null);
    const readFailureReason = [...new Set(failedReads.map((failure) => homeGovernanceFailureNotice(failure, { effect: 'read' }).body))].join('\n');
    // Both observations use the same reload, regardless of which failure needs it.
    const retryRead = failedReads.some((failure) => failure.retryable)
        ? { testID: 'home-reach-retry', label: t('homeGovernance.retry'), onPress: () => { void reads.reload(); } }
        : undefined;
    if (!reach || !reads.settings) {
        if (readFailureReason) {
            return (
                <SurfaceStateCard
                    testID="home-reach-error"
                    kind="error"
                    title={t('homeGovernance.reach.loadFailed')}
                    reason={readFailureReason}
                    action={retryRead}
                />
            );
        }
        // The address rows are reserved in their final shape, so nothing moves when they land.
        return (
            <ItemGroup>
                <ItemLoadStateRows testID="home-reach-loading" state={LOADING} rows={3} accessibilityLabel={t('homeGovernance.reach.title')} />
            </ItemGroup>
        );
    }

    const publicEntry = entryFor(reads.settings, PUBLIC_ADDRESS_KEY);
    const webAppEntry = entryFor(reads.settings, WEBAPP_KEY);
    const publicSubpathEntry = entryFor(reads.settings, PUBLIC_SUBPATH_KEY);
    const relayEntry = entryFor(reads.settings, RELAY_POLICY_KEY);
    const relayUrlsEntry = entryFor(reads.settings, RELAY_URLS_KEY);
    const addressCaption = publicAddressCaption(reach);
    const exposure = resolveReachExposure(reach, context.projection);
    const irohAvailable = reach.iroh.availability === 'available';
    const irohOn = reach.iroh.mode === 'enabled';
    const irohLocked = !isOwner || reach.iroh.modeFixed || !irohAvailable;
    // Only a running Iroh can be retired; an unavailable one has nothing to turn off.
    const cannotRetire = irohAvailable && irohOn && !reachCanRetireIroh(reach);
    const relayCustomCount = Array.isArray(relayUrlsEntry?.value) ? relayUrlsEntry.value.length : 0;
    const relayPolicy = relayEntry?.value === 'disabled' ? 'disabled' : 'automatic';
    const relayPending = relayEntry?.applied?.pending === true;
    const relayRow = {
        testID: 'home-reach-relay',
        title: t('homeGovernance.reach.relay'),
        subtitle: relayEntry?.fixed ? undefined : relayPending
            ? t('homeGovernance.reach.appliesAfterRestartPending')
            : t('homeGovernance.reach.appliesAfterRestart'),
        subtitleLines: 0,
        subtitleAccessory: relayEntry?.fixed ? <HomeDeploymentFixedNote keys={[relayEntry.key]} testID="home-reach-relay" /> : undefined,
    };

    return (
        <>
            {readFailureReason ? (
                <SurfaceFreshnessLine
                    testID="home-reach-refresh-error"
                    tone="warning"
                    reason={readFailureReason}
                    busy={reads.loading || reads.companionLoading}
                    action={retryRead}
                />
            ) : null}
            <ExposureBanner exposure={exposure} onOpenPolicies={() => router.push(homeAdministrationPoliciesPath(context.scope.serverId))} />
            <ReachPathDiagram
                reach={reach}
                homeName={context.homeName}
                machineLabel={t('homeGovernance.reach.homeServer')}
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
                        subtitle={deploymentManaged ? t('homeGovernance.reach.accessMethodDeployment') : undefined}
                        subtitleLines={0}
                        detail={reach.hostAccess ? hostAccessMethodLabel(reach.hostAccess.method) : undefined}
                        showChevron={false}
                        mode="info"
                    />
                </SettingAnchor>
            </ItemGroup>

            {publicSubpathEntry ? (
                <ItemGroup title={t('homeGovernance.reach.publicLinks')} description={t('homeGovernance.reach.publicLinksHelp')}>
                    <SettingAnchor setting={HOME_REACH_SETTINGS.settings.allowPublicSubpath}>
                        <HomeSettingFieldRow
                            testID="home-reach-public-subpath"
                            entry={publicSubpathEntry}
                            title={t('homeGovernance.reach.allowPublicSubpath')}
                            subtitle={t('homeGovernance.reach.allowPublicSubpathDescription')}
                            staged={undefined}
                            readOnly={!isOwner}
                            disabled={disabled || publicLinksBusy}
                            error={publicLinksFailure}
                            onStage={savePublicLinks}
                        />
                    </SettingAnchor>
                    {publicLinksFailure ? <SurfaceStateCard testID="home-reach-public-subpath-error" size="line" kind="error" title={publicLinksFailure} /> : null}
                </ItemGroup>
            ) : null}

            {!deploymentManaged && isOwner ? (
                <HomeRelayManageSection key={JSON.stringify(context.scope)} serverId={context.scope.serverId} disabled={disabled} />
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
                        {isOwner && !relayEntry.fixed ? (
                                <SegmentedChoiceItem<'automatic' | 'disabled'>
                                    {...relayRow}
                                    testIDPrefix="home-reach-relay-policy"
                                    options={[
                                        { id: 'automatic', label: t('homeGovernance.reach.relayAutomatic') },
                                        { id: 'disabled', label: t('homeGovernance.reach.relayOff') },
                                    ]}
                                    value={relayPolicy}
                                    onChange={(tabId) => {
                                        if (tabId === relayPolicy || disabled) return;
                                        // Relays off cannot keep custom relays: the direct-connection runtime refuses both.
                                        void writeSettings(tabId === 'disabled' && relayCustomCount > 0 && relayUrlsEntry && !relayUrlsEntry.fixed
                                            ? { [RELAY_POLICY_KEY]: tabId, [RELAY_URLS_KEY]: null }
                                            : { [RELAY_POLICY_KEY]: tabId });
                                    }}
                                    disabled={disabled}
                                />
                            ) : <Item {...relayRow} mode="info" showChevron={false} detail={relayPolicy === 'disabled' ? t('homeGovernance.reach.relayOff') : t('homeGovernance.reach.relayAutomatic')} />}
                    </SettingAnchor>
                ) : null}
                {irohAvailable && relayPolicy === 'automatic' && relayUrlsEntry ? (
                    <HomeSettingFieldRow
                        testID="home-reach-relay-servers"
                        entry={relayUrlsEntry}
                        title={t('homeGovernance.reach.relayServers')}
                        subtitle={relayUrlsEntry.fixed ? undefined : relayUrlsEntry.applied?.pending === true
                            ? `${t('homeGovernance.reach.relayServersDescription')} ${t('homeGovernance.reach.appliesAfterRestartPending')}`
                            : `${t('homeGovernance.reach.relayServersDescription')} ${t('homeGovernance.reach.appliesAfterRestart')}`}
                        staged={relayUrlsDraft}
                        readOnly={!isOwner}
                        disabled={disabled}
                        error={relayUrlsFailure}
                        onStage={stageRelayUrls}
                        onCommit={commitRelayUrls}
                    />
                ) : null}
            </ItemGroup>
        </>
    );
});

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
    addressLine: {
        maxWidth: '100%',
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
