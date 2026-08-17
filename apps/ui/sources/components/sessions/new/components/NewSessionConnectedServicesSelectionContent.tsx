import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ConnectedServiceId } from '@happier-dev/protocol';

import { resolveConnectedServiceDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { ConnectedServiceQuotaBadgesView } from '@/components/settings/connectedServices/ConnectedServiceQuotaBadgesView';
import { useConnectedServiceQuotaBadges } from '@/hooks/server/connectedServices/useConnectedServiceQuotaBadges';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { StatusPill } from '@/components/ui/selectionList/accessories/StatusPill';
import { SelectionList, resolvePopoverSelectionListHeightBehavior } from '@/components/ui/selectionList';
import { resolvePopoverHeightStyle } from '@/components/ui/popover';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { t } from '@/text';

import type {
    ConnectedServicesAccountGroupOptionsByServiceId,
    ConnectedServicesProfileOptionsByServiceId,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { isConnectedServiceProfileOptionSelectable } from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { buildNewSessionConnectedServicesSelectionListModel } from './buildNewSessionConnectedServicesSelectionListModel';
import { Icon } from '@/components/ui/icons/Icon';

export type NewSessionConnectedServicesSelectionContentProps = Readonly<{
    supportedServiceIds: ReadonlyArray<ConnectedServiceId>;
    profileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId;
    groupOptionsByServiceId: ConnectedServicesAccountGroupOptionsByServiceId;
    bindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
    setBindingForService: (serviceId: string, binding: ConnectedServicesServiceBinding) => void;
    defaultProfileIdByServiceId?: Readonly<Record<string, string | undefined>>;
    includeNativeAuthOption?: boolean;
    allowDefaultProfileFallback?: boolean;
    resolveOptionAvailability?: (params: Readonly<{
        serviceId: string;
        optionId: string;
        binding: ConnectedServicesServiceBinding;
    }>) => Readonly<{ disabled?: boolean; subtitle?: string }>;
    onReconnectProfile?: (serviceId: string, profileId: string) => void;
    // Widened to carry the service: the builder already invokes it with the
    // serviceId, and modal hosts (default-auth picker) route per service.
    // Existing `() => void` callers stay assignable.
    onOpenSettings: (serviceId: string) => void;
    /** Close the hosting surface (popover/modal) — e.g. Escape inside the list. */
    requestClose?: () => void;
    maxHeight: number;
}>;

function SelectionStateIcon(props: Readonly<{ selected: boolean; variant?: 'default' | 'warning' }>) {
    const { theme } = useUnistyles();
    const color = props.selected ? theme.colors.text.primary : theme.colors.text.secondary;

    return normalizeNodeForView(
        <Icon
            name={props.selected ? 'check-circle' : 'circle'}
            size={20}
            color={color}
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
    const [bindingsByServiceId, setBindingsByServiceId] = React.useState(props.bindingsByServiceId);

    React.useEffect(() => {
        setBindingsByServiceId(props.bindingsByServiceId);
    }, [props.bindingsByServiceId]);

    const requestedProfiles = React.useMemo(() => {
        const next: Array<{ serviceId: string; profileId: string }> = [];
        for (const serviceId of props.supportedServiceIds) {
            const options = props.profileOptionsByServiceId[serviceId] ?? [];
            for (const option of options) {
                if (!isConnectedServiceProfileOptionSelectable(option)) continue;
                const profileId = option.profileId.trim();
                if (!profileId) continue;
                next.push({ serviceId, profileId });
            }
        }
        return next;
    }, [props.profileOptionsByServiceId, props.supportedServiceIds]);

    const quotaBadgesByKey = useConnectedServiceQuotaBadges(requestedProfiles, { fetchPolicy: 'cache_only' });

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
    // element identity for every row and re-rendered each row's icon, quota
    // badges and reauth pill instead of skipping them. Only the DATA inputs
    // below may invalidate the model; a replaced handler is picked up through
    // the ref on the next activation.
    const handlersRef = React.useRef({
        setBindingForService: props.setBindingForService,
        onOpenSettings: props.onOpenSettings,
        onReconnectProfile: props.onReconnectProfile,
    });
    handlersRef.current = {
        setBindingForService: props.setBindingForService,
        onOpenSettings: props.onOpenSettings,
        onReconnectProfile: props.onReconnectProfile,
    };

    const setBindingForService = React.useCallback((serviceId: string, binding: ConnectedServicesServiceBinding) => {
        setBindingsByServiceId((prev) => ({ ...prev, [serviceId]: binding }));
        handlersRef.current.setBindingForService(serviceId, binding);
    }, []);
    const openSettings = React.useCallback((serviceId: string) => {
        handlersRef.current.onOpenSettings(serviceId);
    }, []);
    const reconnectProfileHandler = React.useCallback((serviceId: string, profileId: string) => {
        handlersRef.current.onReconnectProfile?.(serviceId, profileId);
    }, []);
    // Presence (not identity) of the reconnect handler is a real render input:
    // without one the builder routes the reauth row to the settings action.
    const reconnectProfile = typeof props.onReconnectProfile === 'function'
        ? reconnectProfileHandler
        : undefined;

    const listModel = React.useMemo(() => {
        return buildNewSessionConnectedServicesSelectionListModel({
            supportedServiceIds: props.supportedServiceIds,
            profileOptionsByServiceId: props.profileOptionsByServiceId,
            groupOptionsByServiceId: props.groupOptionsByServiceId,
            bindingsByServiceId,
            defaultProfileIdByServiceId: props.defaultProfileIdByServiceId,
            includeNativeAuthOption: props.includeNativeAuthOption,
            allowDefaultProfileFallback: props.allowDefaultProfileFallback,
            quotaBadgesByKey,
            setBindingForService,
            onOpenSettings: openSettings,
            translate: t,
            resolveServiceTitle: (serviceId) => resolveConnectedServiceDisplayName(serviceId as ConnectedServiceId, t),
            renderSelectionIcon: ({ selected, variant }) => <SelectionStateIcon selected={selected} variant={variant} />,
            renderSettingsIcon: () => <SettingsActionIcon />,
            renderQuotaBadges: (badges) => <ConnectedServiceQuotaBadgesView badges={badges} />,
            renderNeedsReauthPill: () => (
                <StatusPill
                    variant="stale"
                    label={t('connectedServices.list.needsReauth')}
                    hideDot
                />
            ),
            onReconnectProfile: reconnectProfile,
            resolveOptionAvailability: props.resolveOptionAvailability,
        });
    }, [
        bindingsByServiceId,
        openSettings,
        props.allowDefaultProfileFallback,
        props.defaultProfileIdByServiceId,
        props.includeNativeAuthOption,
        props.groupOptionsByServiceId,
        props.profileOptionsByServiceId,
        // Kept as a dependency on purpose: unlike the handlers above, this one is
        // INVOKED during the build and its result is baked into every option's
        // `disabled` / `subtitle` / icon variant, so a stale reference would
        // freeze availability. Each host supplies it as a memoised callback.
        props.resolveOptionAvailability,
        props.supportedServiceIds,
        quotaBadgesByKey,
        reconnectProfile,
        setBindingForService,
    ]);

    return (
        <View style={[styles.container, resolvePopoverHeightStyle(props.maxHeight)]}>
            <SelectionList
                testID="new-session.connected-services.selection-list"
                rootStep={listModel.rootStep}
                selectedOptionId={listModel.selectedOptionId}
                maxHeight={props.maxHeight}
                heightBehavior={resolvePopoverSelectionListHeightBehavior()}
                keyboardHintsEnabled={false}
                onRequestClose={props.requestClose ?? (() => {})}
                onSelect={() => {}}
            />
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        backgroundColor: theme.colors.background.canvas,
        flexShrink: 1,
    },
}));
