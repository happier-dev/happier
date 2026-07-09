import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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

export type NewSessionConnectedServicesSelectionContentProps = Readonly<{
    supportedServiceIds: ReadonlyArray<ConnectedServiceId>;
    profileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId;
    groupOptionsByServiceId: ConnectedServicesAccountGroupOptionsByServiceId;
    bindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
    setBindingForService: (serviceId: string, binding: ConnectedServicesServiceBinding) => void;
    defaultProfileIdByServiceId?: Readonly<Record<string, string | undefined>>;
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
        <Ionicons
            name={props.selected ? 'checkmark-circle' : 'ellipse-outline'}
            size={20}
            color={color}
        />,
    );
}

function SettingsActionIcon() {
    const { theme } = useUnistyles();
    return normalizeNodeForView(
        <Ionicons name="settings-outline" size={20} color={theme.colors.text.tertiary} />,
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

    const setBindingForService = React.useCallback((serviceId: string, binding: ConnectedServicesServiceBinding) => {
        setBindingsByServiceId((prev) => ({ ...prev, [serviceId]: binding }));
        props.setBindingForService(serviceId, binding);
    }, [props.setBindingForService]);

    const listModel = React.useMemo(() => {
        return buildNewSessionConnectedServicesSelectionListModel({
            supportedServiceIds: props.supportedServiceIds,
            profileOptionsByServiceId: props.profileOptionsByServiceId,
            groupOptionsByServiceId: props.groupOptionsByServiceId,
            bindingsByServiceId,
            defaultProfileIdByServiceId: props.defaultProfileIdByServiceId,
            quotaBadgesByKey,
            setBindingForService,
            onOpenSettings: props.onOpenSettings,
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
            onReconnectProfile: props.onReconnectProfile,
            resolveOptionAvailability: props.resolveOptionAvailability,
        });
    }, [
        bindingsByServiceId,
        props.defaultProfileIdByServiceId,
        props.groupOptionsByServiceId,
        props.onOpenSettings,
        props.onReconnectProfile,
        props.profileOptionsByServiceId,
        props.resolveOptionAvailability,
        props.supportedServiceIds,
        quotaBadgesByKey,
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
