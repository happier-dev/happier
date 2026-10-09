import type * as React from 'react';
import type { ValidatedLaunchSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import type { ManagedReceiptModel } from './MachineConfigurationReceipt';
import type { MachineRetentionOverrideV1 } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import type { BillingCapabilitiesV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { t } from '@/text';
import { describeRetention, describeRetentionPolicy, formatRetentionDuration } from './managedRetentionPresentation';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import type { PluginLocalizedStringV2 } from '@happier-dev/protocol/plugins/contributions/publicTypes';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { presentQualifiedConnectedAccountTarget, type QualifiedConnectedAccountTargetPresentation } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import type { MachineEnvironmentV1 } from '@happier-dev/protocol/machines/managed/machineEnvironmentV1';

/** These are display targets from already validated selections, never new purpose authorizations. */
export function managedCredentialReceiptTargets(launch: ValidatedLaunchSnapshotV1) {
    return (launch.credentials ?? []).map((credential, index) => ({ key: `credential:${index}`,
        target: { kind: 'account' as const, account: credential.account } }));
}

export type ManagedConfigurationReceiptInput = Readonly<{
    launch: ValidatedLaunchSnapshotV1; reviewedFacts?: ManagedConfigurationFactsV1;
    providerTitle: string; controllerName?: string; caption?: string; mark?: React.ReactNode;
    homeName?: string; preset?: ManagedConfigurationFactsV1['preset']; presetPolicy?: MachineRetentionOverrideV1;
    /** Future preset display may use its actual descriptor, without resolving allocation policy. */
    declaredBilling?: BillingCapabilitiesV1;
    environment?: MachineEnvironmentV1;
    localized?: (pluginId: string, value: PluginLocalizedStringV2) => string;
    /** Current target-Home names, resolved by the canonical privacy-aware Account presenter. */
    credentialPresentations?: Readonly<Record<string, QualifiedConnectedAccountTargetPresentation>>;
}>;
export function buildManagedConfigurationReceipt(input: ManagedConfigurationReceiptInput): ManagedReceiptModel {
    const facts = input.reviewedFacts;
    const controllerName = input.controllerName ?? (facts ? t('common.unknown') : undefined);
    const rows: ManagedReceiptModel['facts'][number][] = [];
    const nativeLabels: string[] = [];
    const localized = (value: PluginLocalizedStringV2) => input.localized
        ? input.localized(input.launch.provider.pluginId, value)
        : typeof value === 'string' ? value : value.fallback;
    for (const dimension of ['size', 'image', 'location', 'duration'] as const) {
        const fact = facts?.nativeFacts?.[dimension];
        if (!fact) continue;
        const value = localized(fact.title);
        nativeLabels.push(value);
        rows.push({ id: dimension, label: dimension === 'duration' ? t('managedRetention.ends') : t(`managedMachines.config.${dimension}`), value });
    }
    if (input.homeName) rows.push({ id: 'home', label: t('managedMachines.receipt.joins'), value: input.homeName });
    const preset = facts?.preset ?? input.preset;
    if (preset) rows.push({ id: 'preset', label: t('machinePresets.madeFrom'), value: preset.name
        ? t('machinePresets.fromRevision', { name: preset.name, revision: preset.revision })
        : t('managedMachines.receipt.eachOne', { revision: preset.revision }) });
    if (controllerName) rows.push({ id: 'controller', label: t('managedMachines.config.managedFrom'), value: controllerName });
    for (const [index, credential] of (input.launch.credentials ?? []).entries()) {
        const id = `credential:${index}`;
        const account = input.credentialPresentations?.[id] ?? presentQualifiedConnectedAccountTarget({
            target: { kind: 'account', account: credential.account }, accounts: [], groups: [], labelsByKey: {}, serviceTitle: null,
        });
        rows.push({ id, label: `${buildQualifiedPluginContributionKey(credential.purpose.consumer)} · ${credential.purpose.purpose}`,
            value: account.primaryLabel });
    }
    if (facts) {
        if (facts.nativeFacts?.monthlyCapStatus) rows.push({ id: 'monthly-cap', label: t('managedMachines.billing.monthlyCap'),
            value: t(facts.nativeFacts.monthlyCapStatus === 'none' ? 'managedMachines.billing.noMonthlyCap' : 'managedMachines.billing.unknownMonthlyCap') });
        rows.push({ id: 'retention', label: t('managedRetention.keepIt'), value: describeRetentionPolicy(facts) });
        if (facts.retentionCapabilities.nativeExpiry) {
            const expiry = facts.retentionCapabilities.nativeExpiry;
            rows.push({ id: 'native-expiry', label: t('managedRetention.keepIt'), value: t('managedRetention.nativeExpiry', {
                provider: input.providerTitle, time: expiry.kind === 'deadline' ? formatAsOfTime(expiry.at) : formatRetentionDuration(expiry.afterMs),
            }) });
        }
        if (facts.billing.storageCharges?.length) rows.push({ id: 'stopped-storage', label: t('managedRetention.keepIt'),
            value: t('managedMachines.billing.stopped', { charges: facts.billing.storageCharges.map(price => `${price.amount} ${price.currency} / ${price.unit}`).join(' · ') }) });
    }
    else if (input.presetPolicy) {
        rows.push({ id: 'retention', label: t('managedRetention.keepIt'),
            value: input.presetPolicy.retention ? describeRetention(input.presetPolicy.retention) : t('managedRetention.defaults') });
        if (input.presetPolicy.wakeOnAcceptedMessage !== undefined) rows.push({ id: 'wake', label: t('managedRetention.wake'),
            value: t(input.presetPolicy.wakeOnAcceptedMessage ? 'managedRetention.wakeOn' : 'managedRetention.wakeOff') });
    }
    const [firstPrice, ...otherPrices] = facts?.prices ?? [];
    const presentPrice = (price: NonNullable<ManagedConfigurationFactsV1['prices']>[number]) => ({ ...price,
        ...(price.label !== undefined ? { label: localized(price.label) } : {}) });
    return { caption: input.caption ?? t('managedMachines.receipt.yourNewMachine'), mark: input.mark ?? null,
        name: input.launch.name, spec: nativeLabels.length ? nativeLabels.join(' · ') : input.providerTitle, facts: rows,
        ...(facts?.environment ?? input.environment ? { environment: facts?.environment ?? input.environment } : {}),
        cost: firstPrice ? { kind: 'price', prices: [presentPrice(firstPrice), ...otherPrices.map(presentPrice)] }
            : (facts?.billing ?? input.declaredBilling)?.location === 'local' ? { kind: 'local', computer: controllerName ?? input.providerTitle, meters: [] }
                : { kind: 'unpriced', provider: input.providerTitle } };
}
