import * as React from 'react';
import type { ProviderUsageSourceV1 } from '@happier-dev/protocol/providers/contributions';
import type { ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { SavedSecretSlotBindingsV1 } from '@happier-dev/protocol/providers/settings/v1';
import { resolveSavedSecretSlotBindingIdV1 } from '@happier-dev/protocol/providers/settings/operationsV1';
import { formatUsageCost } from '@happier-dev/protocol/usage/usageFormatting';
import { StyleSheet } from 'react-native-unistyles';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
  UsageMeterRow,
  UsageMeterStack,
} from '@/components/settings/connectedServices/usage/UsageMeterRow';
import { UsageRefreshAction } from '@/components/settings/connectedServices/usage/UsageRefreshAction';
import { ProviderExternalLinkItem } from '@/components/settings/providers/ProviderExternalLinkItem';
import { ProviderSavedSecretControl } from '@/components/settings/providers/ProviderPageParts';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SurfaceStateCard, type SurfaceStateAction } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { presentProviderError } from '@/providers/connection/errorPresentation';
import { useProviderConnectionUsage } from '@/providers/hooks/useProviderConnectionUsage';
import {
  presentProviderConnectionUsage,
  type ProviderConnectionUsagePresentation,
  type ProviderUsageAmount,
  type ProviderUsageMeterPresentation,
  type ProviderUsageScope,
} from '@/sync/domains/connectedServices/accountUsage/presentProviderConnectionUsage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

function formatMoney(
  value: number,
  unit: ProviderUsageMeterPresentation['unit'],
  currency?: string,
): string {
  const magnitude = Math.abs(value);
  const text =
    currency || unit === 'usd'
      ? formatUsageCost(magnitude, currency ?? 'USD')
      : new Intl.NumberFormat().format(magnitude);
  // A reported negative balance is shown as the provider reports it, with a true minus sign.
  return value < 0 ? `−${text}` : text;
}

/** What a provider reported as one figure: "$12.40 left", "$12.40 of $25.00 left", or the amount used. */
export function formatProviderUsageAmount(
  amount: ProviderUsageAmount | null,
  unit: ProviderUsageMeterPresentation['unit'],
  currency?: string,
): string | null {
  if (amount === null) return null;
  switch (amount.kind) {
    case 'used':
      return formatMoney(amount.used, unit, currency);
    case 'remaining':
      return amount.remaining < 0
        ? formatMoney(amount.remaining, unit, currency)
        : t('settingsProvidersCollection.usage.amountLeft', {
            amount: formatMoney(amount.remaining, unit, currency),
          });
    case 'remainingOfLimit':
      return t('settingsProvidersCollection.usage.amountLeftOfLimit', {
        amount: formatMoney(amount.remaining, unit, currency),
        limit: formatMoney(amount.limit, unit, currency),
      });
  }
}

const SCOPE_TITLE_KEY = {
  key: 'settingsProvidersCollection.usage.scopeKey',
  account: 'settingsProvidersCollection.usage.scopeAccount',
} as const satisfies Record<ProviderUsageScope, string>;
const SOURCE_FAILED_KEY = {
  key: 'settingsProvidersCollection.usage.keyFailed',
  account: 'settingsProvidersCollection.usage.accountFailed',
} as const satisfies Record<ProviderUsageScope, string>;

/**
 * A Provider connection's Usage section (rendered only when its Provider declares usage sources): what
 * the provider reports in money, grouped by whose money it is ("This key", "Account"), with the shared
 * usage header (as of, Refresh) and the optional billing key a source asks for. Presented demand
 * acquires once; an unbound billing key shows no account figures, only the field that adds one.
 */
export const ProviderConnectionUsageSection = React.memo(function ProviderConnectionUsageSection(props: Readonly<{
    connectionId: string;
    identity: string;
    providerName: string;
    serverId: string | null;
    scope: ServerAccountScope | null;
    machineId: string | null;
    sources: readonly ProviderUsageSourceV1[];
    secretBindings: SavedSecretSlotBindingsV1 | undefined;
    active: boolean;
    /** Null while the selected machine belongs to another Account: the field explains why it is off. */
    onChooseBillingKey: ((slotId: string, event?: unknown) => void) | null;
    /** Null when the connection has no API key slot or the selected machine belongs to another Account. */
    onChooseApiKey: ((event?: unknown) => void) | null;
}>) {
    const router = useRouter();
    const { refreshProviderConnectionUsage } = useProviderActionClient(props.serverId);
    const usage = useProviderConnectionUsage({
        scope: props.scope, connectionId: props.connectionId, machineId: props.machineId,
        identity: props.identity, secretBindings: props.secretBindings, active: props.active, invoke: refreshProviderConnectionUsage,
    });
    const { secretBindings, machineId } = props;
    const presentation = presentProviderConnectionUsage({
        sources: props.sources,
        isBillingSlotBound: (slotId) => machineId
            ? resolveSavedSecretSlotBindingIdV1(secretBindings, machineId, slotId) !== null
            : Boolean(secretBindings?.account?.[slotId]),
        view: usage.view,
    });
    const approvalHref = usage.pendingApproval?.href ?? null;
    return (
        <ProviderConnectionUsageSectionView
            providerName={props.providerName}
            presentation={presentation}
            refreshing={usage.refreshing}
            failed={usage.failed}
            refresh={usage.refresh}
            onOpenApproval={approvalHref ? () => router.pushRetainingCurrent(approvalHref as never) : null}
            isBillingKeySaved={(slotId) => Boolean(secretBindings?.account?.[slotId])}
            onChooseBillingKey={props.onChooseBillingKey}
            onChooseApiKey={props.onChooseApiKey}
        />
    );
});

/** The section itself, from its presentation: the dev specimen renders every state through it. */
export const ProviderConnectionUsageSectionView = React.memo(function ProviderConnectionUsageSectionView(props: Readonly<{
    providerName: string;
    presentation: ProviderConnectionUsagePresentation;
    refreshing: boolean;
    failed: boolean;
    refresh: (() => void) | null;
    /** Set while a refresh waits for the person's approval. */
    onOpenApproval: (() => void) | null;
    isBillingKeySaved: (slotId: string) => boolean;
    onChooseBillingKey: ((slotId: string, event?: unknown) => void) | null;
    onChooseApiKey: ((event?: unknown) => void) | null;
}>) {
    const styles = stylesheet;
    const { presentation } = props;
    const testID = 'provider-connection-usage';
    const retry = props.refresh ? { label: t('common.retry'), onPress: props.refresh } : undefined;
    const withTestID = (action: SurfaceStateAction | undefined, id: string) => action ? { ...action, testID: `${id}:action` } : undefined;
    const connectionError = presentation.connectionError ? presentProviderError(presentation.connectionError) : null;
    // A failure the person fixes by choosing a key (the provider's typed recovery action) leads to that key's
    // picker, the writer its row uses; Retry stays for every other failure, since it cannot supply a key.
    const keyRecovery = (error: ProviderErrorV1, billingSlotId: string | null): SurfaceStateAction | undefined => {
        if (error.action !== 'add_secret' && error.action !== 'replace_secret') return undefined;
        const choose = billingSlotId === null ? props.onChooseApiKey
            : props.onChooseBillingKey ? (event?: unknown) => props.onChooseBillingKey?.(billingSlotId, event) : null;
        return choose ? {
            label: error.action === 'add_secret' ? t('settingsProvidersCollection.addKey') : t('settingsProvidersCollection.replace'),
            onPress: choose,
        } : undefined;
    };
    const sourceFailures = presentation.sourceErrors.map((failure) => ({ failure, recovery: keyRecovery(failure.error, failure.billingSlotId) }));
    // One Retry refreshes every source: it sits on the first failure that no key picker answers.
    const retryOwnerIndex = sourceFailures.findIndex(({ recovery }) => !recovery);
    const connectionRecovery = presentation.connectionError ? keyRecovery(presentation.connectionError, null) : undefined;
    return (
        <ItemGroup
            testID={testID}
            title={t('settings.usage')}
            description={t('settingsProvidersCollection.usage.description', { provider: props.providerName })}
            action={<UsageRefreshAction testID={testID} fetchedAt={presentation.fetchedAt} refresh={props.refresh} refreshing={props.refreshing} />}
        >
            {props.refreshing && props.onOpenApproval ? (
                <ActionApprovalPendingNotice presentation="line" testID={`${testID}:approval`}
                    message={t('settingsProvidersCollection.approvalPendingTitle')}
                    openLabel={t('settingsProvidersCollection.openApproval')}
                    onOpenApproval={props.onOpenApproval} />
            ) : props.refreshing ? (
                <SurfaceStateCard testID={`${testID}:refreshing`} size="line" kind="loading" title={t('connectedServices.quota.refreshing')} />
            ) : null}
            {presentation.groups.map((group) => (
                <SectionContentRow key={group.scope} testID={`${testID}:${group.scope}`}>
                    <Text style={styles.scope}>{t(SCOPE_TITLE_KEY[group.scope])}</Text>
                    <UsageMeterStack>
                        {group.meters.map((meter) => (
                            <UsageMeterRow
                                key={meter.meterId}
                                testID={`${testID}:meter:${meter.meterId}`}
                                label={meter.label}
                                amount={formatProviderUsageAmount(meter.amount, meter.unit, meter.currency)}
                                remainingPct={meter.remainingPct}
                                resetsAt={null}
                                tone={meter.tone}
                                estimated={meter.estimated}
                                now={0}
                            />
                        ))}
                    </UsageMeterStack>
                </SectionContentRow>
            ))}
            {/* Each failed source says what failed; one Retry refreshes them all. */}
            {sourceFailures.map(({ failure, recovery }, index) => (
                <SurfaceStateCard
                    key={failure.sourceId}
                    testID={`${testID}:error:${failure.sourceId}`}
                    size="line"
                    kind={failure.lastGood ? 'warning' : 'error'}
                    title={t(SOURCE_FAILED_KEY[failure.scope])}
                    reason={t(presentProviderError(failure.error).titleKey)}
                    action={withTestID(recovery ?? (index === retryOwnerIndex ? retry : undefined), `${testID}:error:${failure.sourceId}`)}
                />
            ))}
            {connectionError ? (
                <SurfaceStateCard testID={`${testID}:error`} size="line" kind="error"
                    title={t(connectionError.titleKey)} reason={t(connectionError.descriptionKey)} action={withTestID(connectionRecovery ?? retry, `${testID}:error`)} />
            ) : props.failed ? (
                <SurfaceStateCard testID={`${testID}:error`} size="line" kind="error"
                    title={t('settingsProvidersCollection.usage.refreshFailed')} action={withTestID(retry, `${testID}:error`)} />
            ) : presentation.unsupported ? (
                <SurfaceStateCard testID={`${testID}:unsupported`} size="line" kind="empty"
                    title={t('settingsProvidersCollection.usage.unsupported')} />
            ) : !presentation.checked && !props.refreshing ? (
                <SurfaceStateCard testID={`${testID}:not-checked`} size="line" kind="empty"
                    title={props.refresh ? t('settingsProvidersCollection.usage.notChecked')
                        : t('settingsProvidersCollection.usage.needsMachine')} />
            ) : null}
            {presentation.billingSlots.map((slot) => {
                const saved = props.isBillingKeySaved(slot.slotId);
                const rowTestID = `${testID}:billing-key:${slot.slotId}`;
                return (
                    <React.Fragment key={slot.slotId}>
                        <Item
                            testID={rowTestID}
                            title={slot.title ?? t('settingsProvidersCollection.usage.billingKeyTitle')}
                            subtitle={!props.onChooseBillingKey
                                ? t('settingsProviders.local.accountScopeMismatchDescription')
                                : saved
                                    ? t('settingsProvidersCollection.usage.billingKeySaved')
                                    : t('settingsProvidersCollection.usage.billingKeyMissing')}
                            subtitleLines={0}
                            showChevron={false}
                            rightElement={(
                                <ProviderSavedSecretControl
                                    testID={rowTestID}
                                    saved={saved}
                                    disabled={!props.onChooseBillingKey}
                                    onChoose={(event) => props.onChooseBillingKey?.(slot.slotId, event)}
                                />
                            )}
                            rightElementOutsidePressable
                        />
                        {slot.keyUrl && !saved ? (
                            <ProviderExternalLinkItem kind="getApiKey" url={slot.keyUrl}
                                label={t('settingsProvidersCollection.usage.getBillingKey')} />
                        ) : null}
                    </React.Fragment>
                );
            })}
        </ItemGroup>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
  scope: {
    ...Typography.variant('label', 'medium'),
    color: theme.colors.text.primary,
    marginBottom: theme.space.s8,
  },
}));
