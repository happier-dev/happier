import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
    draftMarketplaceRegistryProfileV1,
    type MarketplaceRegistryProfileRequirementV1,
} from '@happier-dev/protocol/marketplace';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';

import { NpmRegistryProfilesSection, type NpmRegistryProfilesSectionProps } from './NpmRegistryProfilesSection';
import {
    useMarketplaceSourceRegistryAdministration,
    type MarketplaceSourceRegistryAdministrationParamsV1,
} from './model/useMarketplaceSourceRegistryAdministration';

type PluginRegistryProfileSelectionParams = Readonly<{
    /** What the daemon's change owner said this machine must select. */
    requirement: MarketplaceRegistryProfileRequirementV1;
    pluginName: string;
    /** The marketplace source the install resolves through, whose binding selects the profile. */
    sourceId: string | null;
    /** The exact machine and server the selection lands on. */
    target: Readonly<{ machine: string; server: string }>;
    daemonOperationsAvailable: boolean;
    targetSelection: NpmRegistryProfilesSectionProps['targetSelection'];
    sourceRegistry: Pick<
        MarketplaceSourceRegistryAdministrationParamsV1,
        'scopeKey' | 'executionTarget' | 'resolveCurrentExecutionTarget'
    >;
}>;

type PluginRegistryProfileSelectionDialogProps = CustomModalInjectedProps & PluginRegistryProfileSelectionParams & Readonly<{
    onResolve: (proceed: boolean) => void;
}>;

/**
 * The registry selection an install owes before any package bytes are fetched.
 *
 * It is the existing registry profile administration — add a profile, sign in,
 * bind the listing's source — narrowed to the one source the install resolves
 * through, and opened with the registry the daemon named. Nothing here decides
 * whether the selection is sufficient: Continue asks the daemon again, and the
 * daemon either prepares the Install and Trust review or names what is still
 * missing.
 */
export function PluginRegistryProfileSelectionDialog(props: PluginRegistryProfileSelectionDialogProps) {
    const { theme } = useUnistyles();
    const { onClose, onResolve } = props;
    const sourceRegistry = useMarketplaceSourceRegistryAdministration({
        ...props.sourceRegistry,
        enabled: props.daemonOperationsAvailable,
        focused: true,
    });
    const source = props.sourceId === null
        ? null
        : sourceRegistry.registry?.sources.find((entry) => entry.id === props.sourceId) ?? null;
    const marketplaceSources = React.useMemo(() => (source ? [source] : []), [source]);
    const createProfileSubject = React.useMemo(
        () => draftMarketplaceRegistryProfileV1(props.requirement),
        [props.requirement],
    );

    const resolve = React.useCallback((proceed: boolean) => {
        onResolve(proceed);
        onClose();
    }, [onClose, onResolve]);

    const footer = React.useMemo(() => (
        <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
        }}>
            <RoundButton
                size="normal"
                display="inverted"
                title={t('common.cancel')}
                testID="settings.plugins.registrySelection.cancel"
                onPress={() => resolve(false)}
            />
            <RoundButton
                size="normal"
                title={t('settingsPlugins.discover.registrySelection.continue')}
                testID="settings.plugins.registrySelection.continue"
                disabled={sourceRegistry.mutationInFlight}
                onPress={() => resolve(true)}
            />
        </View>
    ), [resolve, sourceRegistry.mutationInFlight]);

    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: t('settingsPlugins.discover.registrySelection.title', { name: props.pluginName }),
        testID: 'settings.plugins.registrySelection',
        dimensions: { width: 640, maxHeightRatio: 0.9, size: 'lg' as const },
        footer,
    }), [footer, props.pluginName]);

    useModalCardChrome(props.setChrome, chrome);

    return (
        <View style={{ flex: 1, minHeight: 0 }}>
            <ScrollView
                style={{ flex: 1 }}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingTop: 14, paddingBottom: 18, gap: 12 }}
            >
                <View style={{ paddingHorizontal: 20, gap: 6 }}>
                    <Text
                        testID="settings.plugins.registrySelection.body"
                        style={{ ...Typography.default(), color: theme.colors.text.primary }}
                    >
                        {t('settingsPlugins.discover.registrySelection.body', {
                            name: props.pluginName,
                            origin: props.requirement.registryOrigin,
                            source: source?.title ?? props.sourceId ?? props.requirement.registryOrigin,
                        })}
                    </Text>
                    <Text
                        testID="settings.plugins.registrySelection.target"
                        style={{ ...Typography.default('semiBold'), color: theme.colors.text.secondary }}
                    >
                        {t('settingsPlugins.pluginChangeConfirmTarget', props.target)}
                    </Text>
                </View>
                <NpmRegistryProfilesSection
                    daemonOperationsAvailable={props.daemonOperationsAvailable}
                    targetSelection={props.targetSelection}
                    marketplaceSources={marketplaceSources}
                    onSetMarketplaceSourceProfile={sourceRegistry.setSourceRegistryProfile}
                    marketplaceSourceMutationInFlight={sourceRegistry.mutationInFlight}
                    createProfileSubject={createProfileSubject}
                />
            </ScrollView>
        </View>
    );
}

/**
 * Asks the present user for the registry selection an install owes. Resolves
 * `true` when they chose to continue, and `false` for Cancel, dismissal, or the
 * host being torn down.
 */
export async function showPluginRegistryProfileSelectionDialog(
    params: PluginRegistryProfileSelectionParams,
): Promise<boolean> {
    const deferred = createDeferredOnce<boolean>();
    Modal.show({
        component: PluginRegistryProfileSelectionDialog,
        props: { ...params, onResolve: deferred.resolve },
        onRequestClose: () => deferred.resolve(false),
        onHostUnmount: () => deferred.resolve(false),
        closeOnBackdrop: true,
    });
    return await deferred.promise;
}
