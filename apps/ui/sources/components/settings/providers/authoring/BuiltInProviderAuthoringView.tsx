import * as React from 'react';
import type { ProviderWireProtocol } from '@happier-dev/protocol/providers/capabilities/v1';
import type { ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { DaemonProviderContributionAuthoringPreviewV1 } from '@happier-dev/protocol/rpc';
import type { ProviderEndpointTemplateV1 } from '@happier-dev/protocol/providers/contributions';
import { useUnistyles } from 'react-native-unistyles';

import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
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
import { EndpointHeadersEditor } from '@happier-dev/plugin-ui';
import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { endpointHeadersCopy } from '../endpointHeadersCopy';

type PreviewCredential = Readonly<Pick<NonNullable<DaemonProviderContributionAuthoringPreviewV1['credential']>,
    'required' | 'authorityDescription' | 'additionalCredentials'>>;

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
    /** Managed configuration has no external endpoint preview or pasted API key. */
    gatewayDraft?: Readonly<{ ready: boolean; fields?: React.ReactNode }>;
    machineId: string | null;
    currentMachineName: string;
    providerName: string | null;
    icon: string | null;
    contributionKey?: string | null;
    provenance: 'first_party' | 'external' | null;
    keyUrl?: string;
    previewCredential: PreviewCredential | null;
    endpointTemplates: readonly Readonly<Pick<ProviderEndpointTemplateV1,
        'requiresEndpointOverride' | 'addressConstraint' | 'modelIdPattern' | 'requiredPublicHeaders' | 'publicHeaders' | 'publicHeaderHints'> & {
        id: string;
        protocol: ProviderWireProtocol;
    }>[];
    endpointValues: Readonly<Record<string, string>>;
    endpointPublicHeaders?: Readonly<Record<string, Readonly<Record<string, string>>>>;
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
    onEndpointPublicHeadersChange?: (endpointTemplateId: string, publicHeaders: Record<string, string> | null) => void;
    /** Resolves the contributing plugin's localized text (header hints, key labels and authority). */
    localizeText?: (value: unknown) => string;
    onSave: () => void;
    onDiscard: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const connectBlocked = Boolean(props.previewCredential?.required && (!props.savedSecretSelectionEnabled
        || !props.secretSelected));
    const waitingForApproval = Boolean(props.pendingApproval);
    const destinationReady = props.gatewayDraft ? props.gatewayDraft.ready : props.preview?.status === 'resolved' && !props.previewLoading;
    // Connect acts only on a reviewed destination, even for a stale callback or Enter in the key field.
    const connect = () => {
        if (destinationReady && !connectBlocked && !waitingForApproval) props.onSave();
    };
    // A key-based provider supplies its own addresses: overriding them is a rare, opened-on-demand
    // choice. A provider without a required key is reached at an address, so its endpoints stay open.
    const hasEndpointValues = props.endpointTemplates.some((endpoint) => (props.endpointValues[endpoint.id] ?? '').trim() !== '');
    // Addresses the provider cannot supply are asked for at once.
    const endpointsRequired = props.endpointTemplates.some((endpoint) => endpoint.requiresEndpointOverride === true);
    const [endpointsExpanded, setEndpointsExpanded] = React.useState(
        () => props.previewCredential?.required !== true || hasEndpointValues || endpointsRequired,
    );
    const localize = props.localizeText ?? localizeLiteral;
    return (
        // A gateway draft sits in the Connected services column at the account and pool pages' width.
        <ItemList testID="settings-provider-authoring-built-in" pageColumn={props.gatewayDraft ? 'wide' : undefined}>
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
                    // A gateway asks for no key: it draws on the subscriptions chosen below.
                    : props.gatewayDraft
                        ? t('settingsProvidersCollection.gateway.description')
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
                    title: t(props.gatewayDraft ? 'common.create' : 'settingsProvidersCollection.connect'),
                    loading: (props.savePending && !waitingForApproval) || props.previewLoading,
                    disabled: connectBlocked || waitingForApproval || !destinationReady,
                    onPress: connect,
                }}
                cancelAction={{
                    testID: 'settings-provider-authoring-cancel',
                    title: t(props.gatewayDraft ? 'common.discard' : 'common.cancel'),
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
                description={props.gatewayDraft || !props.previewLoading && props.preview?.status === 'resolved' && props.preview.scope === 'account'
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
                {/* A second key is chosen on the saved provider: this sheet saves one key (no two-key Add yet). */}
                {(props.previewCredential?.additionalCredentials ?? []).map((slot) => (
                    <Item
                        key={slot.slotId}
                        testID={`settings-provider-authoring-additional-key:${slot.slotId}`}
                        mode="info"
                        title={slot.label ? localize(slot.label) : t('settingsProviders.authoring.apiKey')}
                        subtitle={t('settingsProvidersCollection.companionKeyAfterConnect')}
                        subtitleLines={0}
                    />
                ))}
                {props.previewCredential?.authorityDescription ? (
                    <Item
                        testID="settings-provider-authoring-key-authority"
                        mode="info"
                        title={t('settingsProvidersCollection.keyAuthorityTitle')}
                        subtitle={localize(props.previewCredential.authorityDescription)}
                        subtitleLines={0}
                    />
                ) : null}
                {props.nameField}
            </ItemGroup>
            {/* The gateway's own sections, each with its sheet, follow the name rather than nesting in its card. */}
            {props.gatewayDraft?.fields}
            {props.endpointTemplates.length > 0 ? (
                // The header editor is the public plugin-ui one, so its sheet sits in core's plugin presentation scope.
                <CorePluginUiPresentationScope>
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
                                subtitle={t(endpointsRequired
                                    ? 'settingsProvidersCollection.endpointsRequiredDescription'
                                    : 'settingsProvidersCollection.endpointsDescription')}
                                subtitleLines={0}
                            />
                        )}
                    >
                        {props.endpointTemplates.flatMap((endpoint) => [
                            <ProviderFieldRow
                                key={endpoint.id}
                                testID={`settings-provider-authoring-endpoint-${endpoint.id}`}
                                title={endpointProtocolLabel(endpoint.protocol)}
                                value={props.endpointValues[endpoint.id] ?? ''}
                                placeholder={t('settingsProviders.authoring.baseUrlPlaceholder')}
                                keyboardType="url"
                                monospace
                                onChangeText={(baseUrl) => props.onEndpointChange(endpoint.id, baseUrl)}
                            />,
                            props.onEndpointPublicHeadersChange ? (
                                <EndpointHeadersEditor
                                    key={`${endpoint.id}:headers`}
                                    testID={`settings-provider-authoring-endpoint-${endpoint.id}`}
                                    layer="draft"
                                    values={props.endpointPublicHeaders?.[endpoint.id] ?? null}
                                    inherited={endpoint.publicHeaders ?? NO_HEADERS}
                                    copy={endpointHeadersCopy('draft')}
                                    required={endpoint.requiredPublicHeaders}
                                    hints={localizeHints(endpoint.publicHeaderHints, localize)}
                                    disabled={props.savePending}
                                    onChange={(next) => props.onEndpointPublicHeadersChange?.(endpoint.id, next)}
                                />
                            ) : null,
                        ])}
                    </ExpandableItem>
                </ItemGroup>
                </CorePluginUiPresentationScope>
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

const NO_HEADERS: Readonly<Record<string, string>> = Object.freeze({});

/** An author literal is its own text; a keyed string falls back to the author's fallback. */
function localizeLiteral(value: unknown): string {
    if (typeof value === 'string') return value;
    const fallback = (value as { fallback?: unknown } | null)?.fallback;
    return typeof fallback === 'string' ? fallback : '';
}

export function localizeHints(
    hints: Readonly<Record<string, unknown>> | undefined,
    localize: (value: unknown) => string,
): Record<string, string> | undefined {
    return hints ? Object.fromEntries(Object.entries(hints).map(([name, hint]) => [name, localize(hint)])) : undefined;
}
