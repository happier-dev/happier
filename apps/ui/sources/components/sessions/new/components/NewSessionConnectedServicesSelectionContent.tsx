import type { ProviderDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import type { DirectDeliveryDisclosure } from '@/components/sessions/teamCredentials/directDeliveryDisclosure';
import type { TeamCredentialResourceStatusByKey } from '@/sync/domains/teams/teamCredentialResourceStatus';
import * as React from 'react';
import type { PopoverAnchor } from '@/components/ui/popover';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ConnectedAccountServiceKey } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';

import { useProjectedConnectedServicesRegistry } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveQualifiedConnectedServiceRegistryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { useConnectedServiceQuotaBadgeState } from '@/hooks/server/connectedServices/useConnectedServiceQuotaBadges';
import type { ConnectedServiceQuotaProfileRefInput } from '@/sync/domains/connectedServices/connectedServiceQuotaProfileRefs';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { SelectionList, resolvePopoverSelectionListHeightBehavior, type SelectionListHeightBehavior } from '@/components/ui/selectionList';
import { resolvePopoverHeightStyle } from '@/components/ui/popover';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { t } from '@/text';

import type {
    ConnectedServicesAccountGroupOptionsByServiceId,
    ConnectedServicesProfileOptionsByServiceId,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { isConnectedServiceProfileOptionSelectable } from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import {
    buildNewSessionConnectedServicesSelectionListModel,
    foldUnavailableSelectionRows,
    type ConnectedServicesSelectionIconVariant,
    type ConnectedServicesSelectionRowKind,
    type ConnectedServicesSelectionOptionAvailability,
} from './buildNewSessionConnectedServicesSelectionListModel';
import { RouteSourceChevron, useSessionRouteSourceSections, type SessionRouteSources } from './useSessionRouteSourceSections';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { PoolUsageFreshness } from '@/components/settings/connectedServices/pools/PoolUsageFreshness';
import { SessionModelSourceBrowseHandoffContext } from '@/components/sessions/modelPicker/SessionModelSourceBrowseHandoff';
import type { SessionRoute } from '@/providers/session/resolveSessionRoutePresentation';
import { useNewSessionConnectedServiceOptions, type NewSessionConnectedServiceOptionsInput } from '../modules/useNewSessionConnectedServiceOptions';

export type NewSessionConnectedServicesSelectionContentProps = Readonly<{
    supportedServiceIds: ReadonlyArray<ConnectedAccountServiceKey>;
    profileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId;
    groupOptionsByServiceId: ConnectedServicesAccountGroupOptionsByServiceId;
    /** Present only when this mounted picker owns its Account inventory demand. */
    inventoryInput?: NewSessionConnectedServiceOptionsInput;
    bindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
    bindingsKnown?: boolean;
    teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
    teamCredentialDisplayNames?: Readonly<Record<string, string | null>>;
    declarationContext?: ProviderDeclarationContext;
    teamCredentialResourceStatusByKey?: TeamCredentialResourceStatusByKey;
    teamNameById?: Readonly<Record<string, string>>;
    /** Where agents run on the selected target now, for the Direct delivery disclosure. */
    directDelivery?: DirectDeliveryDisclosure;
    onRecoverTeamCredentialResource?: (resource: TeamCredentialResourceCatalogEntryV1) => void;
    setBindingForService: (serviceId: string, binding: ConnectedServicesServiceBinding) => void;
    defaultProfileIdByServiceId?: Readonly<Record<string, string | undefined>>;
    includeNativeAuthOption?: boolean;
    unavailableNativeSignInServiceIds?: readonly string[];
    allowDefaultProfileFallback?: boolean;
    resolveOptionAvailability?: (params: Readonly<{
        serviceId: string;
        optionId: string;
        binding: ConnectedServicesServiceBinding;
    }>) => ConnectedServicesSelectionOptionAvailability;
    onReconnectProfile?: (serviceId: string, profileId: string, anchor?: PopoverAnchor) => void;
    // Widened to carry the service: the builder already invokes it with the
    // serviceId, and modal hosts (default-auth picker) route per service.
    // Existing `() => void` callers stay assignable.
    onOpenSettings: (serviceId: string, anchor?: PopoverAnchor) => void;
    /**
     * Leads the list while a route or model change is armed for the running session's next message
     * (D15); the list keeps the height left over.
     */
    armedNote?: string | null;
    /** The "Runs through" popover also names the Agent's Gateways and Providers; other hosts omit it. */
    routeSources?: SessionRouteSources;
    /** Exact selected Agent, also available when Provider browsing is disabled. */
    nativeAgentTargetKey?: string;
    /** Applied route from the canonical presentation owner, separate from pending intent. */
    appliedRoute?: SessionRoute;
    /** Close the hosting surface (popover/modal) — e.g. Escape inside the list. */
    requestClose?: () => void;
    maxHeight: number;
    /** A card-modal host keeps the card to its rows (`resolveSelectionListModalHeightBehavior`); popovers keep theirs. */
    heightBehavior?: SelectionListHeightBehavior;
}>;

const ROW_KIND_ICON = {
    native: 'terminal',
    group: 'stack',
    account: 'user-circle',
    team: 'users',
} as const satisfies Record<ConnectedServicesSelectionRowKind, string>;

/** Names what the row is; the list draws the current choice's check, so this never changes with it. */
function RowKindIcon(props: Readonly<{ kind: ConnectedServicesSelectionRowKind; variant?: ConnectedServicesSelectionIconVariant }>) {
    const { theme } = useUnistyles();
    return normalizeNodeForView(
        <Icon
            name={ROW_KIND_ICON[props.kind]}
            size={20}
            color={props.variant === 'warning' ? theme.colors.text.tertiary : theme.colors.text.secondary}
        />,
    );
}

function SettingsActionIcon() {
    const { theme } = useUnistyles();
    return normalizeNodeForView(
        <Icon name="sliders-horizontal" size={20} color={theme.colors.text.tertiary} />,
    );
}

export function NewSessionConnectedServicesSelectionContent(props: NewSessionConnectedServicesSelectionContentProps) {
    const styles = stylesheet;
    const inventory = useNewSessionConnectedServiceOptions(props.inventoryInput ?? null);
    const profileOptionsByServiceId = props.inventoryInput ? inventory.profileOptionsByServiceId : props.profileOptionsByServiceId;
    const groupOptionsByServiceId = props.inventoryInput ? inventory.groupOptionsByServiceId : props.groupOptionsByServiceId;
    const connectedServicesRegistry = useProjectedConnectedServicesRegistry();
    const sourceBrowse = React.useContext(SessionModelSourceBrowseHandoffContext)?.browse;
    const nativeAgentTargetKey = props.nativeAgentTargetKey ?? props.routeSources?.agentTargetKey;
    const appliedTeamRoute = React.useMemo(() => props.appliedRoute?.kind === 'team'
        ? { teamId: props.appliedRoute.teamId, resourceId: props.appliedRoute.resourceId, deliveryMode: props.appliedRoute.deliveryMode }
        : undefined, [props.appliedRoute]);

    /** Public applied-descriptor title; neutral fallback for an unknown service. */
    const resolveServiceTitle = React.useCallback((serviceId: string) => {
        const service = parseQualifiedPluginContributionKey(serviceId);
        return service
            ? resolveQualifiedConnectedServiceRegistryDisplayName(connectedServicesRegistry, service, t)
            : t('connectedServices.fallbackName');
    }, [connectedServicesRegistry]);

    const requestedProfiles = React.useMemo(() => {
        const next: ConnectedServiceQuotaProfileRefInput[] = [];
        for (const serviceId of props.supportedServiceIds) {
            const service = parseQualifiedPluginContributionKey(serviceId);
            const options = profileOptionsByServiceId[serviceId] ?? [];
            for (const option of options) {
                if (!isConnectedServiceProfileOptionSelectable(option)) continue;
                const profileId = option.profileId.trim();
                if (!profileId) continue;
                next.push(service ? { ref: { service, accountId: profileId } } : { serviceId, profileId });
            }
        }
        return next;
    }, [profileOptionsByServiceId, props.supportedServiceIds]);

    const { snapshotsByKey: quotaSnapshotsByKey, errorsByKey: quotaErrorsByKey } = useConnectedServiceQuotaBadgeState(requestedProfiles, { fetchPolicy: 'cache_only' });

    // The row handlers are BEHAVIOUR, not data, so they are held in a ref and
    // invoked through stable wrappers instead of being memo dependencies.
    //
    // Every host builds this content through a render callback that the hosting
    // surface re-invokes with a freshly created element on each render while it
    // is open (the popover hosts at minimum once more when the measured
    // placement lands). Two of them cannot hoist their handlers at all —
    // `useSessionConnectedServicesAuthSwitch` closes each one over the
    // per-invocation `requestClose` — so with the raw handlers in the dependency
    // list, every one of those passes rebuilt the whole step tree: each option
    // object plus its `icon` and `rightAccessory` elements. React then lost
    // element identity for every row and re-rendered each row's icon
    // instead of skipping them. Only the DATA inputs
    // below may invalidate the model; a replaced handler is picked up through
    // the ref on the next activation.
    const handlersRef = React.useRef({
        setBindingForService: props.setBindingForService,
        onOpenSettings: props.onOpenSettings,
        onReconnectProfile: props.onReconnectProfile,
        onRecoverTeamCredentialResource: props.onRecoverTeamCredentialResource,
    });
    handlersRef.current = {
        setBindingForService: props.setBindingForService,
        onOpenSettings: props.onOpenSettings,
        onReconnectProfile: props.onReconnectProfile,
        onRecoverTeamCredentialResource: props.onRecoverTeamCredentialResource,
    };

    const setBindingForService = React.useCallback((serviceId: string, binding: ConnectedServicesServiceBinding) => {
        handlersRef.current.setBindingForService(serviceId, binding);
    }, []);
    const nativeRoute = React.useMemo(() => nativeAgentTargetKey ? {
        agentTargetKey: nativeAgentTargetKey,
        active: props.appliedRoute?.kind === 'native',
        onBrowse: sourceBrowse ? () => sourceBrowse(nativeAgentTargetKey, {
            connectionId: null,
            label: t('connectedServices.authModal.nativeAuthTitle'),
        }, () => {
            for (const serviceId of props.supportedServiceIds) setBindingForService(serviceId, { source: 'native' });
        }) : undefined,
    } : undefined, [nativeAgentTargetKey, props.appliedRoute?.kind, props.bindingsByServiceId, props.supportedServiceIds, setBindingForService, sourceBrowse]);
    const openSettings = React.useCallback((serviceId: string, anchor?: PopoverAnchor) => {
        handlersRef.current.onOpenSettings(serviceId, anchor);
    }, []);
    const reconnectProfileHandler = React.useCallback((serviceId: string, profileId: string, anchor?: PopoverAnchor) => {
        handlersRef.current.onReconnectProfile?.(serviceId, profileId, anchor);
    }, []);
    // Presence (not identity) of the reconnect handler is a real render input:
    // without one the builder routes the reauth row to the settings action.
    const reconnectProfile = typeof props.onReconnectProfile === 'function'
        ? reconnectProfileHandler
        : undefined;
    const recoverTeamCredentialResourceHandler = React.useCallback((resource: TeamCredentialResourceCatalogEntryV1) => {
        handlersRef.current.onRecoverTeamCredentialResource?.(resource);
    }, []);
    const recoverTeamCredentialResource = typeof props.onRecoverTeamCredentialResource === 'function'
        ? recoverTeamCredentialResourceHandler
        : undefined;

    const listModel = React.useMemo(() => {
        return buildNewSessionConnectedServicesSelectionListModel({
            supportedServiceIds: props.supportedServiceIds,
            profileOptionsByServiceId,
            groupOptionsByServiceId,
            bindingsByServiceId: props.bindingsByServiceId,
            bindingsKnown: props.bindingsKnown,
            teamCredentialResources: props.teamCredentialResources,
            teamCredentialDisplayNames: props.teamCredentialDisplayNames,
            declarationContext: props.declarationContext,
            teamCredentialResourceStatusByKey: props.teamCredentialResourceStatusByKey,
            teamNameById: props.teamNameById,
            directDelivery: props.directDelivery,
            onRecoverTeamCredentialResource: recoverTeamCredentialResource,
            defaultProfileIdByServiceId: props.defaultProfileIdByServiceId,
            includeNativeAuthOption: props.includeNativeAuthOption,
            unavailableNativeSignInServiceIds: props.unavailableNativeSignInServiceIds,
            nativeRoute,
            appliedTeamRoute,
            allowDefaultProfileFallback: props.allowDefaultProfileFallback,
            quotaSnapshotsByKey,
            quotaErrorsByKey,
            renderPoolFreshness: (freshness, subtitle, serviceTitle) => <View>
                <Text style={styles.poolSubtitle}>{subtitle}</Text>
                <PoolUsageFreshness freshness={freshness} serviceTitle={serviceTitle} />
            </View>,
            setBindingForService,
            onOpenSettings: openSettings,
            translate: t,
            resolveServiceTitle,
            renderRowIcon: ({ kind, variant }) => <RowKindIcon kind={kind} variant={variant} />,
            renderBrowseMark: () => <RouteSourceChevron />,
            renderSettingsIcon: () => <SettingsActionIcon />,
            onReconnectProfile: reconnectProfile,
            resolveOptionAvailability: props.resolveOptionAvailability,
        });
    }, [
        props.bindingsByServiceId,
        props.bindingsKnown,
        nativeRoute,
        appliedTeamRoute,
        openSettings,
        props.allowDefaultProfileFallback,
        props.defaultProfileIdByServiceId,
        props.includeNativeAuthOption,
        props.unavailableNativeSignInServiceIds,
        profileOptionsByServiceId,
        groupOptionsByServiceId,
        props.teamCredentialResources,
        props.teamCredentialDisplayNames,
        props.declarationContext,
        props.teamCredentialResourceStatusByKey,
        props.teamNameById,
        props.directDelivery,
        // Kept as a dependency on purpose: unlike the handlers above, these two
        // are INVOKED during the build and their results are baked into every
        // option's `disabled` / `subtitle` / icon variant / section title, so a
        // stale reference would freeze availability or titles. Each is supplied
        // as a memoised callback.
        props.resolveOptionAvailability,
        props.supportedServiceIds,
        quotaSnapshotsByKey,
        quotaErrorsByKey,
        reconnectProfile,
        recoverTeamCredentialResource,
        resolveServiceTitle,
        setBindingForService,
    ]);

    const routeSourceSections = useSessionRouteSourceSections(props.routeSources, props.appliedRoute);
    // What can run reads first; everything that can't, from accounts to sources, sits in one group last.
    const rootStep = React.useMemo(() => ({
        ...listModel.rootStep,
        sections: foldUnavailableSelectionRows(
            [...listModel.rootStep.sections, ...routeSourceSections],
            listModel.optionAvailabilityById,
            t('common.unavailable'),
        ),
    }), [listModel.rootStep, listModel.optionAvailabilityById, routeSourceSections]);

    const [topContentHeight, setTopContentHeight] = React.useState(0);
    const hasTopContent = Boolean(props.armedNote);
    const listMaxHeight = hasTopContent ? Math.max(0, props.maxHeight - topContentHeight) : props.maxHeight;

    return (
        <View style={[styles.container, resolvePopoverHeightStyle(props.maxHeight)]}>
            {hasTopContent ? (
                <View
                    style={styles.topContent}
                    onLayout={(event) => {
                        const height = Math.round(event.nativeEvent.layout.height);
                        setTopContentHeight((current) => current === height ? current : height);
                    }}
                >
                    <Text testID="session-route-armed-note" style={styles.armedNote}>{props.armedNote}</Text>
                </View>
            ) : null}
            <SelectionList
                testID="new-session.connected-services.selection-list"
                rootStep={rootStep}
                selectedOptionId={listModel.selectedOptionId}
                optionPresentation="menu"
                maxHeight={listMaxHeight}
                heightBehavior={props.heightBehavior ?? resolvePopoverSelectionListHeightBehavior()}
                keyboardHintsEnabled={false}
                onRequestClose={props.requestClose ?? (() => {})}
                onSelect={() => {}}
            />
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    // No fill of its own: the popover or sheet around it draws the shared floating material.
    container: {
        width: '100%',
        flexShrink: 1,
    },
    topContent: {
        flexShrink: 0,
        paddingHorizontal: theme.space.s12,
        paddingTop: theme.space.s8,
    },
    armedNote: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    poolSubtitle: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
}));
