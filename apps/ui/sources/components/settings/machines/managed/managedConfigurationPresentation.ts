import type * as React from 'react';
import type { ValidatedLaunchSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import type { ManagedReceiptModel } from './MachineConfigurationReceipt';
import { formatProviderAmount, formatPriceUnit, type ManagedReceiptCost } from './managedMachineDisplay';
import type { ManagedLocalResourceFactsV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { formatByteCapacity } from '@/utils/files/formatByteSize';
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
    /**
     * The receipt of a machine that exists: its caption says what it was made from, and it leaves out
     * policy (the live Keep it sits beside it; a creation-time policy next to the current one would
     * contradict it) and creation-time headroom that no longer describes the host.
     */
    created?: boolean;
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
    const billingLocation = (facts?.billing ?? input.declaredBilling)?.location;
    // The size is the receipt's spec line; the other dimensions are its facts, image first for a local
    // VM (what you will see on this computer) and place first in the cloud (lab m-config receipts).
    const size = facts?.nativeFacts?.size;
    for (const dimension of billingLocation === 'local' ? ['image', 'location', 'duration'] as const : ['location', 'image', 'duration'] as const) {
        const fact = facts?.nativeFacts?.[dimension];
        if (!fact) continue;
        const value = localized(fact.title);
        nativeLabels.push(value);
        rows.push({ id: dimension, label: dimension === 'duration' ? t('managedRetention.ends') : t(`managedMachines.config.${dimension}`), value });
    }
    const sizeSpec = size ? describeManagedSize(localized(size.title), size) : null;
    // Lab receipt order: where and what, then who pays, who manages it and where it joins.
    const credentials = input.launch.credentials ?? [];
    for (const [index, credential] of credentials.entries()) {
        const id = `credential:${index}`;
        const account = input.credentialPresentations?.[id] ?? presentQualifiedConnectedAccountTarget({
            target: { kind: 'account', account: credential.account }, accounts: [], groups: [], labelsByKey: {}, serviceTitle: null,
        });
        // One account is simply "Account"; several are told apart by the purpose each one serves.
        rows.push({ id, label: credentials.length === 1 ? t('managedMachines.receipt.account')
            : `${buildQualifiedPluginContributionKey(credential.purpose.consumer)} · ${credential.purpose.purpose}`,
            value: account.primaryLabel });
    }
    if (controllerName) rows.push({ id: 'controller', label: t('managedMachines.config.managedFrom'), value: controllerName });
    if (input.homeName) rows.push({ id: 'home', label: t('managedMachines.receipt.joins'), value: input.homeName });
    const preset = facts?.preset ?? input.preset;
    const presetLine = preset ? preset.name
        ? t('machinePresets.fromRevision', { name: preset.name, revision: preset.revision })
        : t('managedMachines.receipt.eachOne', { revision: preset.revision }) : null;
    // A created machine names its preset in the caption, where the lab puts it.
    if (presetLine && !input.created) rows.push({ id: 'preset', label: t('machinePresets.madeFrom'), value: presetLine });
    if (facts) {
        if (facts.nativeFacts?.monthlyCapStatus) rows.push({ id: 'monthly-cap', label: t('managedMachines.billing.monthlyCap'),
            value: t(facts.nativeFacts.monthlyCapStatus === 'none' ? 'managedMachines.billing.noMonthlyCap' : 'managedMachines.billing.unknownMonthlyCap') });
        if (!input.created) rows.push({ id: 'retention', label: t('managedRetention.keepIt'), value: describeRetentionPolicy(facts) });
        if (facts.retentionCapabilities.nativeExpiry && !input.created) {
            const expiry = facts.retentionCapabilities.nativeExpiry;
            rows.push({ id: 'native-expiry', label: t('managedRetention.keepIt'), value: t('managedRetention.nativeExpiry', {
                provider: input.providerTitle, time: expiry.kind === 'deadline' ? formatAsOfTime(expiry.at) : formatRetentionDuration(expiry.afterMs),
            }) });
        }
        if (facts.billing.storageCharges?.length) rows.push({ id: 'stopped-storage', label: t('managedRetention.keepIt'),
            value: t('managedMachines.billing.stopped', { charges: facts.billing.storageCharges.map(price => `${formatProviderAmount(price)} ${formatPriceUnit(price.unit)}`).join(' · ') }) });
    }
    else if (input.presetPolicy && !input.created) {
        rows.push({ id: 'retention', label: t('managedRetention.keepIt'),
            value: input.presetPolicy.retention ? describeRetention(input.presetPolicy.retention) : t('managedRetention.defaults') });
        if (input.presetPolicy.wakeOnAcceptedMessage !== undefined) rows.push({ id: 'wake', label: t('managedRetention.wake'),
            value: t(input.presetPolicy.wakeOnAcceptedMessage ? 'managedRetention.wakeOn' : 'managedRetention.wakeOff') });
    }
    const [firstPrice, ...otherPrices] = facts?.prices ?? [];
    const presentPrice = (price: NonNullable<ManagedConfigurationFactsV1['prices']>[number]) => ({ ...price,
        ...(price.label !== undefined ? { label: localized(price.label) } : {}) });
    const caption = input.caption ?? (input.created ? presetLine ?? t('managedMachines.receipt.asCreated') : t('managedMachines.receipt.yourNewMachine'));
    return { caption, mark: input.mark ?? null,
        name: input.launch.name, spec: sizeSpec ?? (nativeLabels.length ? nativeLabels.join(' · ') : input.providerTitle), facts: rows,
        ...(facts?.environment ?? input.environment ? { environment: facts?.environment ?? input.environment } : {}),
        cost: firstPrice ? { kind: 'price', prices: [presentPrice(firstPrice), ...otherPrices.map(presentPrice)] }
            : billingLocation === 'local' ? describeLocalCost({ computer: controllerName ?? input.providerTitle, size,
                resources: input.created ? undefined : facts?.localResources, omitHeadroom: input.created === true })
                : { kind: 'unpriced', provider: input.providerTitle } };
}

type NativeSizeFact = NonNullable<NonNullable<ManagedConfigurationFactsV1['nativeFacts']>['size']>;

/** The labelled native dimensions a size declares, as the receipt says them: "4 cores", "8 GB", "80 GB". */
export function managedSizeDimensions(size: NativeSizeFact): string[] {
    return [size.cpuCores === undefined ? null : t('managedMachines.receipt.cores', { count: size.cpuCores }),
        size.memoryBytes === undefined ? null : formatByteCapacity(size.memoryBytes),
        size.diskBytes === undefined ? null : formatByteCapacity(size.diskBytes)]
        .filter((part): part is string => part !== null);
}

/** "CX32 · 4 cores · 8 GB · 80 GB": the size's name, then whichever dimensions it declares. */
export function describeManagedSize(title: string, size: NativeSizeFact): string {
    return [title, ...managedSizeDimensions(size)].join(' · ');
}

/**
 * A local VM's share of the computer it runs on: its declared cores and memory against what the host
 * reported free when the choices were read. Only measured facts become meters; a missing measurement
 * says it is unknown rather than drawing an invented share.
 */
function describeLocalCost(input: Readonly<{ computer: string; size?: NativeSizeFact; resources?: ManagedLocalResourceFactsV1;
    omitHeadroom: boolean }>): ManagedReceiptCost {
    const { computer, size, resources } = input;
    const meters: Extract<ManagedReceiptCost, { kind: 'local' }>['meters'][number][] = [];
    const cores = size?.cpuCores !== undefined && resources?.availableCpuCores !== undefined && resources.availableCpuCores > 0
        ? { used: size.cpuCores, free: resources.availableCpuCores } : null;
    const memory = size?.memoryBytes !== undefined && resources?.availableMemoryBytes !== undefined && resources.availableMemoryBytes > 0
        ? { used: size.memoryBytes, free: resources.availableMemoryBytes } : null;
    if (cores) meters.push({ id: 'cpu', label: t('managedMachines.config.columns.cpu'), fraction: Math.min(1, cores.used / cores.free),
        value: t('managedMachines.receipt.coresOfFree', { count: cores.used, free: String(cores.free) }) });
    if (memory) meters.push({ id: 'memory', label: t('managedMachines.config.columns.memory'), fraction: Math.min(1, memory.used / memory.free),
        value: t('managedMachines.receipt.amountOfFree', { amount: formatByteCapacity(memory.used), free: formatByteCapacity(memory.free) }) });
    if (input.omitHeadroom) return { kind: 'local', computer, meters: [] };
    if (!cores && !memory) return { kind: 'local', computer, meters, note: t('managedMachines.receipt.headroomUnknown', { computer }) };
    if (cores && cores.used > cores.free || memory && memory.used > memory.free) {
        return { kind: 'local', computer, meters, note: t('managedMachines.receipt.exceedsFree', { computer }) };
    }
    const leftCores = cores ? t('managedMachines.receipt.cores', { count: cores.free - cores.used }) : null;
    const leftMemory = memory ? formatByteCapacity(memory.free - memory.used) : null;
    return { kind: 'local', computer, meters, note: leftCores && leftMemory
        ? t('managedMachines.receipt.leavesBoth', { cores: leftCores, memory: leftMemory, computer })
        : t('managedMachines.receipt.leavesOne', { amount: leftCores ?? leftMemory ?? '', computer }) };
}

/**
 * What a local size leaves free on its computer, from the computer's measured free resources: the
 * size table's "Left for MacBook Pro" column. Unmeasured parts are left out; a size that does not fit
 * says so instead of a negative number.
 */
export function describeLocalHeadroom(size: NativeSizeFact, resources: ManagedLocalResourceFactsV1 | undefined): string | undefined {
    if (!resources) return undefined;
    const cores = size.cpuCores !== undefined && resources.availableCpuCores !== undefined ? resources.availableCpuCores - size.cpuCores : null;
    const memory = size.memoryBytes !== undefined && resources.availableMemoryBytes !== undefined ? resources.availableMemoryBytes - size.memoryBytes : null;
    if (cores === null && memory === null) return undefined;
    if ((cores ?? 0) < 0 || (memory ?? 0) < 0) return t('managedMachines.config.notEnoughFree');
    return [cores === null ? null : t('managedMachines.receipt.cores', { count: cores }),
        memory === null ? null : formatByteCapacity(memory)].filter((part): part is string => part !== null).join(' · ');
}
