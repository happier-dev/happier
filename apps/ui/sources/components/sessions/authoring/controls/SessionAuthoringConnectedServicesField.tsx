import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import type {
    ConnectedServiceBindingsV2,
    PluginContributionIdentityV1,
    PluginProjectedAgentConnectedAccountPurposeV2,
} from '@happier-dev/protocol';

import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import type { AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { useNewSessionConnectedServices } from '@/components/sessions/new/modules/useNewSessionConnectedServices';
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

export function SessionAuthoringConnectedServicesField(props: Readonly<{
    agentId: string;
    agentIdentity: PluginContributionIdentityV1 | null;
    connectedAccounts: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
    context: SessionAuthoringConnectedServicesContext;
    value: ConnectedServiceBindingsV2 | null | undefined;
    onChange: (value: ConnectedServiceBindingsV2 | null) => void;
    chipRenderContext: AgentInputExtraActionChipRenderContext;
    testID: string;
}>): React.ReactElement | null {
    const { onChange } = props;
    const router = useRouter();
    const settings = useSettingsSelector((settings) => ({
        connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
        connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
        connectedServicesAdditionalDefaultAuthByAgentIdV1: settings.connectedServicesAdditionalDefaultAuthByAgentIdV1,
    }));

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
        enabled: credentialResourcesEnabled,
    });
    const teamCredentialResources = teamCredentialCatalog.resources;

    const { connectedServicesBindingsPayload, connectedServicesAuthChip } = useNewSessionConnectedServices({
        agentCore,
        defaultAuthAgentId: props.agentId,
        defaultAuthConsumer: props.agentIdentity,
        connectedAccounts: props.connectedAccounts,
        agentOptionState,
        settings: {
            connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId ?? {},
            ...(settings.connectedServicesDefaultAuthByAgentIdV1 === undefined
                ? {}
                : { connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1 }),
            ...(settings.connectedServicesAdditionalDefaultAuthByAgentIdV1 === undefined
                ? {}
                : { connectedServicesAdditionalDefaultAuthByAgentIdV1: settings.connectedServicesAdditionalDefaultAuthByAgentIdV1 }),
        },
        targetServerId: serverId,
        // Choosing native for every service is an authored "use no connected
        // account", not an absence. New Session omits the payload in that case
        // because omission is its own answer there; here it would silently
        // restore inheritance.
        emitWhenAllNative: true,
        teamCredentialResources,
        teamCredentialResourceCurrentKeys: teamCredentialCatalog.currentResourceKeys,
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
        <View testID={props.testID} style={{ alignSelf: 'flex-start' }}>
            {connectedServicesAuthChip.render(renderContext)}
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
