import * as React from 'react';
import type { ProviderWireProtocol } from '@happier-dev/protocol/providers/capabilities/v1';
import type { ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { DaemonProviderContributionAuthoringPreviewV1 } from '@happier-dev/protocol/rpc';
import { useUnistyles } from 'react-native-unistyles';

import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { ExpandableItem, ExpandableItemCaret } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { endpointProtocolLabel } from '@/providers/connection/endpointProtocolLabel';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import { t } from '@/text';
import { ProviderErrorItems } from '../ProviderErrorItems';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { ProviderKeyEntryItem } from './ProviderKeyEntryItem';
import { ProviderFieldRow } from './ProviderFieldRow';

type PreviewCredential = Readonly<{ required: boolean }>;

/**
 * A provider from the catalog being added in the Providers collection, in one step (PA1): its key
 * and an optional name in one sheet (and, where the catalog asks, its endpoints); Connect saves it,
 * switched on. Where its requests go is asked only when it is a choice between destinations; a
 * destination on one computer is that computer's business, shown under "On this computer" on the
 * saved provider.
 */
export function BuiltInProviderAuthoringView(props: Readonly<{
    /** The optional Name row, owned by the screen that holds the draft. */
    nameField?: React.ReactNode;
    machineId: string | null;
    currentMachineName: string;
    providerName: string | null;
    icon: string | null;
    contributionKey?: string | null;
    provenance: 'first_party' | 'external' | null;
    keyUrl?: string;
    previewCredential: PreviewCredential | null;
    endpointTemplates: readonly Readonly<{
        id: string;
        protocol: ProviderWireProtocol;
    }>[];
    endpointValues: Readonly<Record<string, string>>;
    secretSelected: boolean;
    selectedSecretName?: string | null;
    savedSecretSelectionEnabled: boolean;
    preview: DaemonProviderContributionAuthoringPreviewV1 | null;
    previewLoading: boolean;
    savePending: boolean;
    /** Connect is waiting for its approval: say so and offer the approval, instead of a spinner. */
    pendingApproval?: Readonly<{ onOpen: () => void }> | null;
    error: ProviderErrorV1 | string | null;
    errorRetry?: () => void | Promise<void>;
    secondaryTextColor: string;
    warningColor: string;
    onPickSecret: (event?: unknown) => void;
    onChooseCandidate: (candidateId: string) => void;
    onEndpointChange: (endpointTemplateId: string, baseUrl: string) => void;
    onSave: () => void;
    onDiscard: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const connectBlocked = Boolean(props.previewCredential?.required && (!props.savedSecretSelectionEnabled
        || !props.secretSelected));
    const waitingForApproval = Boolean(props.pendingApproval);
    // Connect acts only on a reviewed destination, even for a stale callback or Enter in the key field.
    const connect = () => {
        if (props.preview?.status === 'resolved' && !props.previewLoading && !connectBlocked && !waitingForApproval) props.onSave();
    };
    // A key-based provider supplies its own addresses: overriding them is a rare, opened-on-demand
    // choice. A provider without a required key is reached at an address, so its endpoints stay open.
    const hasEndpointValues = props.endpointTemplates.some((endpoint) => (props.endpointValues[endpoint.id] ?? '').trim() !== '');
    const [endpointsExpanded, setEndpointsExpanded] = React.useState(
        () => props.previewCredential?.required !== true || hasEndpointValues,
    );
    return (
        <ItemList testID="settings-provider-authoring-built-in">
            <PageHeader
                testID="settings-provider-authoring-header"
                alwaysShowTitle
                title={props.providerName
                    ? t('settingsProvidersCollection.addTitle', { provider: props.providerName })
                    : t('settingsProviders.authoring.providerTitle')}
                titleAccessory={props.provenance === 'external' ? (
                    <StatusPill
                        testID="settings-provider-authoring-experimental"
                        variant="neutral"
                        label={t('settingsProviders.compatibility.experimental')}
                        hideDot
                    />
                ) : undefined}
                description={props.provenance === 'external'
                    ? t('settingsProviders.compatibility.experimentalDescription')
                    : props.providerName
                        ? t('settingsProvidersCollection.addDescription', { provider: props.providerName })
                        : t('settingsProviders.authoring.builtInDescription')}
                leading={(
                    <PageHeaderMarkSlot>
                        <ProviderIcon contributionKey={props.contributionKey} icon={props.icon} size={24} color={theme.colors.text.secondary} />
                    </PageHeaderMarkSlot>
                )}
                primaryAction={{
                    testID: 'settings-provider-authoring-connect',
                    title: t('settingsProvidersCollection.connect'),
                    loading: (props.savePending && !waitingForApproval) || props.previewLoading,
                    disabled: connectBlocked || waitingForApproval || props.preview?.status !== 'resolved' || props.previewLoading,
                    onPress: connect,
                }}
                cancelAction={{
                    testID: 'settings-provider-authoring-cancel',
                    title: t('common.cancel'),
                    disabled: props.savePending,
                    onPress: props.onDiscard,
                }}
            />
            {props.pendingApproval ? (
                <ActionApprovalPendingNotice presentation="banner" testID="settings-provider-authoring-approval"
                    message={t('settingsProvidersCollection.approvalPendingTitle')}
                    description={t('settingsProvidersCollection.approvalPendingDescription', { provider: props.providerName ?? t('settingsProviders.authoring.providerTitle') })}
                    openLabel={t('settingsProvidersCollection.openApproval')}
                    onOpenApproval={props.pendingApproval.onOpen}
                />
            ) : null}
            {props.error ? <ItemGroup><ProviderErrorItems error={props.error} retry={props.errorRetry} /></ItemGroup> : null}
            {/* Said only once the daemon resolved an Account destination: then no computer is involved. */}
            <ItemGroup
                description={!props.previewLoading && props.preview?.status === 'resolved' && props.preview.scope === 'account'
                    ? t('settingsProvidersCollection.addAccountScopeHint')
                    : undefined}
            >
                {props.previewCredential ? (
                    // PA1: the key is asked for where it is needed; Add key opens the Connect sheet at the button.
                    <ProviderKeyEntryItem
                        description={props.previewCredential.required
                            ? t('settingsProvidersCollection.addKeyDescription')
                            : t('settingsProviders.authoring.apiKeyOptionalDescription')}
                        keyUrl={props.keyUrl}
                        secretSelected={props.secretSelected}
                        selectedSecretName={props.selectedSecretName}
                        savedSecretSelectionEnabled={props.savedSecretSelectionEnabled}
                        onPickSecret={props.onPickSecret}
                    />
                ) : null}
                {props.nameField}
            </ItemGroup>
            {props.endpointTemplates.length > 0 ? (
                <ItemGroup>
                    <ExpandableItem
                        testID="settings-provider-authoring-endpoints"
                        expanded={endpointsExpanded}
                        onExpandedChange={setEndpointsExpanded}
                        header={(state) => (
                            <Item
                                {...state.headerProps}
                                testID="settings-provider-authoring-endpoints.header"
                                title={t('settingsProvidersCollection.endpointsTitle')}
                                subtitle={t('settingsProvidersCollection.endpointsDescription')}
                                subtitleLines={0}
                                showChevron={false}
                                rightElement={<ExpandableItemCaret expanded={state.expanded} />}
                            />
                        )}
                    >
                        {props.endpointTemplates.map((endpoint) => (
                            <ProviderFieldRow
                                key={endpoint.id}
                                testID={`settings-provider-authoring-endpoint-${endpoint.id}`}
                                title={endpointProtocolLabel(endpoint.protocol)}
                                value={props.endpointValues[endpoint.id] ?? ''}
                                placeholder={t('settingsProviders.authoring.baseUrlPlaceholder')}
                                keyboardType="url"
                                monospace
                                onChangeText={(baseUrl) => props.onEndpointChange(endpoint.id, baseUrl)}
                            />
                        ))}
                    </ExpandableItem>
                </ItemGroup>
            ) : null}
            {/* Where requests go is asked only when there is a choice to make; Connect waits for it. */}
            <PoliteAccessibilityStatus
                statusTestID="settings-provider-authoring-destination-status"
                transitionKey={props.previewLoading ? 'resolving' : 'settled'}
                announcement={props.previewLoading ? t('settingsProviders.authoring.destinationLoading') : ''}
            />
            {!props.previewLoading && props.preview?.status === 'selection_required' ? (
                <ItemGroup
                    title={t('settingsProviders.authoring.destinationReview')}
                    description={t('settingsProvidersCollection.destinationDescription')}
                >
                    <Item mode="info" title={t('settingsProviders.authoring.destinationSelection')} subtitle={t('settingsProviders.authoring.destinationSelectionDescription')} subtitleLines={0} />
                    {props.preview.candidates.map((candidate) => (
                        <Item
                            key={candidate.candidateId}
                            testID={`settings-provider-authoring-candidate:${candidate.candidateId}`}
                            title={candidate.endpoints[0]?.normalizedUrl ?? t('settingsProviders.authoring.destinationReview')}
                            subtitle={candidate.scope === 'machine'
                                ? `${t('settingsProviders.authoring.destinationMachine')} · ${candidate.machineId === props.machineId ? props.currentMachineName : candidate.machineId}`
                                : t('settingsProviders.authoring.destinationAccount')}
                            onPress={() => props.onChooseCandidate(candidate.candidateId)}
                        />
                    ))}
                </ItemGroup>
            ) : null}
        </ItemList>
    );
}
