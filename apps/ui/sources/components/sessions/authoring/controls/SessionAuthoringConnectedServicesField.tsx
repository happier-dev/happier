import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import type {
    ConnectedServiceBindingsV2} from '@happier-dev/protocol/connect/connected-service-bindings';
import type {
    PluginContributionIdentityV1} from '@happier-dev/protocol/plugins/contribution-identity';
import type {
    PluginProjectedAgentConnectedAccountPurposeV2,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import type { AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { SessionAuthoringChipDescriptorTrigger } from './SessionAuthoringFieldSelectTrigger';
import { useNewSessionConnectedServices } from '@/components/sessions/new/modules/useNewSessionConnectedServices';
import { getConnectedServicesAuthActionChipPlacement } from '@/components/sessions/agentInput/definitions/createConnectedServicesAuthActionChip';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { CONNECTED_SERVICES_BINDINGS_KEY } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { useSettingsSelector } from '@/sync/domains/state/storage';

import type { SessionAuthoringConnectedServicesContext } from './sessionAuthoringFieldControls';

/**
 * The controlled Connected Service bindings for an authoring value.
 *
 * The chip, its per-service auth label, the selection panel, the Team credential
 * resource coordinator and the reconnect/settings routing are the incumbent New
 * Session Connected Services owner's, so a workflow default or step override
 * binds exactly what New Session binds — including a Team resource. This
 * component only adapts the controlled value to that owner's option-state
 * contract and hosts the chip's content popover, which the composer bar's
 * overlay controller would otherwise own.
 */

export type SessionAuthoringConnectedServicesChipParams = Readonly<{
    agentId: string;
    agentIdentity: PluginContributionIdentityV1 | null;
    connectedAccounts: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
    unavailableNativeSignInServiceIds?: readonly string[];
    context: SessionAuthoringConnectedServicesContext;
    value: ConnectedServiceBindingsV2 | null | undefined;
    onChange: (value: ConnectedServiceBindingsV2 | null) => void;
    /**
     * A Composer aimed at several Sessions whose routes differ: the chip says this instead of the route, and its
     * popover chooses no row (Mixed means nothing is chosen) until the person picks one.
     */
    mixedLabel?: string;
    /**
     * Whether the value is an edit the person made here (the chip then rides the row). Defaults to any authored
     * value; a Composer that shows its targets' current value passes only its own pending edit.
     */
    pending?: boolean;
}>;

/**
 * The controlled "Runs through" chip descriptor for an authoring value: the incumbent New Session owner adapted to
 * a value-in, `onChange`-out contract. A form hosts it through `SessionAuthoringConnectedServicesField`; a Composer
 * passes it to `AgentInput`, whose overlay owner then hosts its popover.
 */
export function useSessionAuthoringConnectedServicesChip(props: SessionAuthoringConnectedServicesChipParams) {
    const { onChange } = props;
    const router = useRouter();
    const settings = useSettingsSelector((settings) => ({
        connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
    }), ["connectedServicesDefaultProfileByServiceId"]);

    /**
     * Only an omitted value inherits: the owner then seeds its preview from the
     * Account's own default-auth settings exactly as New Session does. Any
     * authored value is explicit, so its record is handed over under the
     * canonical bindings key and the default-auth fallback must not reinterpret
     * it — the owner reads absence of that key, not a falsy record, as
     * inheritance. An authored `null` is the explicit "no connected account",
     * so it carries an empty binding map rather than collapsing into omission
     * and displaying — then saving — Account defaults nobody chose here.
     */
    const agentOptionState = React.useMemo<Record<string, unknown> | null>(() => (
        props.value === undefined
            ? null
            : { [CONNECTED_SERVICES_BINDINGS_KEY]: props.value?.bindingsByServiceId ?? {} }
    ), [props.value]);

    // The owner reports each pick through its option-state writer. Arm exactly
    // one report for that pick; derived rehydration never calls this writer and
    // therefore cannot escape as a new authored override. A parent replacement
    // also invalidates an edit that has not reached its reporting effect yet.
    const pendingUserEditRef = React.useRef(false);
    const parentValueRef = React.useRef(props.value);
    if (!Object.is(parentValueRef.current, props.value)) {
        parentValueRef.current = props.value;
        pendingUserEditRef.current = false;
    }
    const setAgentOptionStateForCurrentAgent = React.useCallback((key: string) => {
        if (key !== CONNECTED_SERVICES_BINDINGS_KEY) return;
        pendingUserEditRef.current = true;
    }, []);

    const agentCore = React.useMemo(
        () => (isBundledAgentId(props.agentId) ? getAgentCore(props.agentId) : null),
        [props.agentId],
    );

    /** The shared picker owns service matching, currentness, and recovery. */
    const serverId = props.context.serverId;
    const credentialResourcesFeatureScope = React.useMemo(
        () => (serverId === null ? undefined : { scopeKind: 'spawn' as const, serverId }),
        [serverId],
    );
    const credentialResourcesEnabled = useFeatureEnabled('teams.credentialResources', credentialResourcesFeatureScope);
    const teamCredentialCatalog = useHomeTeamCredentialModelCatalog({
        serverId,
        machineId: props.context.machineId ?? null,
        enabled: credentialResourcesEnabled,
    });
    const teamCredentialResources = teamCredentialCatalog.resources;

    const { connectedServicesBindingsPayload, connectedServicesAuthChip } = useNewSessionConnectedServices({
        placementId: getConnectedServicesAuthActionChipPlacement({ scoped: true }).id,
        placementPending: props.pending ?? props.value !== undefined,
        ...(props.mixedLabel === undefined ? {} : { mixedLabel: props.mixedLabel }),
        agentCore,
        defaultAuthAgentId: props.agentId,
        defaultAuthConsumer: props.agentIdentity,
        connectedAccounts: props.connectedAccounts,
        unavailableNativeSignInServiceIds: props.unavailableNativeSignInServiceIds,
        agentOptionState,
        settings: {
            connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId ?? {},
        },
        targetServerId: serverId,
        // Choosing native for every service is an authored "use no connected
        // account", not an absence. New Session omits the payload in that case
        // because omission is its own answer there; here it would silently
        // restore inheritance.
        emitWhenAllNative: true,
        teamCredentialResources,
        teamCredentialDisplayNames: teamCredentialCatalog.displayNames,
        teamCredentialResourceStatusByKey: teamCredentialCatalog.resourceStatusByKey,
        teamNameById: teamCredentialCatalog.teamNameById,
        router,
        setAgentOptionStateForCurrentAgent,
    });

    // Consume the one-shot edit even when its resolved payload equals the
    // current effective preview: choosing that value still authors an explicit
    // override. Later controlled echoes/resets can only rehydrate the preview.
    React.useEffect(() => {
        if (!pendingUserEditRef.current) return;
        pendingUserEditRef.current = false;
        onChange(connectedServicesBindingsPayload);
    }, [connectedServicesBindingsPayload, onChange]);

    return connectedServicesAuthChip;
}

export function SessionAuthoringConnectedServicesField(props: Readonly<{
    agentId: string;
    agentIdentity: PluginContributionIdentityV1 | null;
    connectedAccounts: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
    context: SessionAuthoringConnectedServicesContext;
    value: ConnectedServiceBindingsV2 | null | undefined;
    onChange: (value: ConnectedServiceBindingsV2 | null) => void;
    mixedLabel?: string;
    chipRenderContext: AgentInputExtraActionChipRenderContext;
    /** `select`: the bordered field select of the `selects` presentation; the composer chip otherwise. */
    trigger?: 'chip' | 'select';
    testID: string;
}>): React.ReactElement | null {
    const connectedServicesAuthChip = useSessionAuthoringConnectedServicesChip(props);

    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ComponentRef<typeof View> | null>(null);
    const renderContext = React.useMemo<AgentInputExtraActionChipRenderContext>(() => ({
        ...props.chipRenderContext,
        chipAnchorRef: anchorRef,
        toggleCollapsedPopover: () => setOpen((current) => !current),
    }), [props.chipRenderContext]);

    if (connectedServicesAuthChip === null) return null;
    const popover = connectedServicesAuthChip.collapsedContentPopover;
    return (
        // Never wider than its row: a long account name ellipsizes inside the field (WF-ACCEPT-1118B item 1, Auth).
        <View testID={props.testID} style={{ alignSelf: 'flex-start', maxWidth: '100%' }}>
            <SessionAuthoringChipDescriptorTrigger chip={connectedServicesAuthChip} renderContext={renderContext} trigger={props.trigger}
                anchorRef={anchorRef} open={open} onToggle={() => setOpen((current) => !current)} testID={props.testID} />
            {popover === undefined ? null : (
                <AgentInputContentPopover
                    open={open}
                    anchorRef={anchorRef}
                    content={popover.renderContent}
                    onRequestClose={() => setOpen(false)}
                    {...(popover.maxHeightCap === undefined ? {} : { maxHeightCap: popover.maxHeightCap })}
                    {...(popover.maxWidthCap === undefined ? {} : { maxWidthCap: popover.maxWidthCap })}
                    {...(popover.scrollEnabled === undefined ? {} : { scrollEnabled: popover.scrollEnabled })}
                />
            )}
        </View>
    );
}
