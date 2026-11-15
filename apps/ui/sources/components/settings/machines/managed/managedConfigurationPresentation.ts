import type * as React from 'react';
import { readManagedCredentialSelectionValueV1, type ManagedMachineEnrollmentIdentityV1, type ValidatedLaunchSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { actionInputOptionValueKey, resolveEffectiveActionInputFields, type ActionInputHints } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { deriveActionInputHints } from '@happier-dev/protocol/actions/schemaInputHints';
import type { JsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { readInputPath } from '@happier-dev/protocol/inputs';
import { resolveActionFieldPresentationForInput, formatActionInputFieldChoice } from '@/components/sessions/actions/ActionInputFields';
import { buildSessionActionFieldOptionsResolver } from '@/components/sessions/actions/sessionActionFieldOptions';
import { deliveryModeLabel } from '@/sync/domains/teams/teamCredentialDeliveryPresentation';
import { describeManagedSize as describeSharedManagedSize, managedSizeDimensions as sharedManagedSizeDimensions,
    formatManagedSizeBytes, resolveManagedConfigurationCost,
    type ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
export { formatManagedSizeBytes } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import type { ManagedReceiptModel } from './MachineConfigurationReceipt';
import { countryFlag, formatPriceSource, presentManagedCost, type ManagedReceiptCost } from './managedMachineDisplay';
import type { ManagedLocalResourceFactsV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { MachineRetentionOverrideV1 } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import type { BillingCapabilitiesV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { t } from '@/text';
import { describeRetention, describeRetentionPolicy, formatRetentionDuration } from './managedRetentionPresentation';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import type { PluginLocalizedStringV2 } from '@happier-dev/protocol/plugins/contributions/public-types';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { presentQualifiedConnectedAccountTarget, presentConnectedAccountPurposeTeamResource, type QualifiedConnectedAccountTargetPresentation } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';

/** These are display targets from already validated selections, never new purpose authorizations. */
export function managedCredentialReceiptTargets(launch: ValidatedLaunchSnapshotV1) {
    return (launch.credentials ?? []).flatMap((credential, index) => 'account' in credential ? [{ key: `credential:${index}`,
        target: { kind: 'account' as const, account: credential.account } }] : []);
}

/** Team display facts come from offered choices, never from their underlying personal Account. */
export function managedCredentialPresentations(input: Readonly<{
    credentialPurposes: MachineProvisionersListResultV1['provisioners'][number]['credentialPurposes'];
    credentials: ValidatedLaunchSnapshotV1['credentials'];
    personal: Readonly<Record<string, QualifiedConnectedAccountTargetPresentation>>;
}>): Readonly<Record<string, QualifiedConnectedAccountTargetPresentation>> {
    const names = { ...input.personal };
    for (const { options } of input.credentialPurposes ?? []) for (const { value, label } of options) {
        if ('accountId' in value) continue;
        const mode = deliveryModeLabel(value.selection.deliveryMode);
        names[`credential-choice:${actionInputOptionValueKey(value)}`] = {
            primaryLabel: label, secondaryLabel: mode, accessibilityLabel: `${label} · ${mode}`,
        };
    }
    for (const [index, credential] of (input.credentials ?? []).entries()) {
        if ('account' in credential) continue;
        const name = names[`credential-choice:${actionInputOptionValueKey(readManagedCredentialSelectionValueV1(credential))}`];
        if (name) names[`credential:${index}`] = { ...name, primaryLabel: name.accessibilityLabel };
    }
    return names;
}

export type ManagedConfigurationReceiptInput = Readonly<{
    launch: ValidatedLaunchSnapshotV1; reviewedFacts?: ManagedConfigurationFactsV1;
    /** Saved configuration fields come from its declaration: shown under declared titles when no native facts describe them. */
    savedLaunchPresentation?: Readonly<{ schema: JsonSchemaObject; inputHints?: ActionInputHints }>;
    /** The declared service title; null when no current or bundled declaration can name it. */
    providerTitle: string | null;
    /** The managing computer's name: `null` while reading it, omitted when unavailable. */
    controllerName?: string | null; caption?: string; mark?: React.ReactNode;
    /** `account`: no computer manages it (an Account-created machine), so there is no Managed from row (58d U4). */
    managedBy?: 'computer' | 'account';
    /**
     * A pool-backed preset: any connected machine in the pool manages it. Its sentences name that machine
     * ("a machine in Build servers") and no single machine's free CPU and memory can be checked beforehand.
     */
    pooledController?: Readonly<{ sentenceName: string }>;
    /** Who each agent signs in as on it: the Account's per-agent default sign-in, by agent title; `null` while read (58d U4). */
    agentSignIn?: readonly Readonly<{ agent: string; account: string | null }>[];
    homeName?: string; preset?: ManagedConfigurationFactsV1['preset']; presetPolicy?: MachineRetentionOverrideV1;
    /** Future preset display may use its actual descriptor, without resolving allocation policy. */
    declaredBilling?: BillingCapabilitiesV1;
    setup?: MachineSetupV1;
    localized?: (pluginId: string, value: PluginLocalizedStringV2) => string;
    /**
     * The receipt of a machine that exists: its caption says what it was made from, and it leaves out
     * policy (the live Keep it sits beside it; a creation-time policy next to the current one would
     * contradict it) and creation-time headroom that no longer describes the host.
     */
    created?: boolean;
    /** A created resource that no longer exists: it neither runs nor bills, so the receipt is only its record (no cost). */
    absent?: boolean;
    /** The receipt carries the editable Keep it control: its policy is not also listed as a fact above it. */
    keepEditedBelow?: boolean;
    /** The created detail's shared Keep control already presents the current native Ends fact. */
    nativeLifetimePresented?: boolean;
    /** Current target-Home names, resolved by the canonical privacy-aware Account presenter. */
    credentialPresentations?: Readonly<Record<string, QualifiedConnectedAccountTargetPresentation>>;
    /** The reviewed creation identity: who Happier runs as there and its administrator access. */
    enrollmentIdentity?: ManagedMachineEnrollmentIdentityV1;
    /**
     * A preset's size and image as last saved (a machine made with exactly its saved choices). Shown only when the
     * current facts can't be read, and always labelled as last saved, never as current state.
     */
    lastSaved?: Pick<NonNullable<ManagedConfigurationFactsV1['nativeFacts']>, 'size' | 'image'>;
}>;
/** Account-default sign-in is display data, independent of reviewed native launch facts. */
export function managedAgentSignInReceiptFacts(agentSignIn: ManagedConfigurationReceiptInput['agentSignIn']): ManagedReceiptModel['facts'] {
    const signIn = agentSignIn ?? [];
    // One agent reads as its account; several are told apart by agent (lab af-config: "Agents sign in as").
    return signIn.length ? [{ id: 'agents', label: t('managedMachines.receipt.agentsSignInAs'),
        value: signIn.some(entry => entry.account === null) ? null : signIn.length === 1
            ? signIn[0]!.account : signIn.map(entry => `${entry.agent} · ${entry.account}`).join(', ') }] : [];
}

export function buildManagedConfigurationReceipt(input: ManagedConfigurationReceiptInput): ManagedReceiptModel {
    const facts = input.reviewedFacts;
    // Retain a pending name, but omit an unavailable name rather than inventing one.
    const controllerName = input.controllerName;
    const rows: ManagedReceiptModel['facts'][number][] = [];
    const nativeLabels: string[] = [];
    const localized = (value: PluginLocalizedStringV2) => input.localized
        ? input.localized(input.launch.provider.pluginId, value)
        : typeof value === 'string' ? value : value.fallback;
    const billingLocation = (facts?.billing ?? input.declaredBilling)?.location;
    // The size is the receipt's spec line; the other dimensions are its facts, image first for a local
    // VM (what you will see on this computer) and place first in the cloud (lab m-config receipts).
    const size = facts?.nativeFacts?.size;
    for (const dimension of billingLocation === 'local' ? ['image', 'location', 'network'] as const : ['location', 'image', 'network'] as const) {
        const fact = facts?.nativeFacts?.[dimension];
        if (!fact) continue;
        const value = localized(fact.title);
        nativeLabels.push(value);
        // A place leads with its country's flag wherever the receipt names it, as in the location choices.
        const flag = dimension === 'location' ? countryFlag('countryCode' in fact ? fact.countryCode : undefined) : '';
        rows.push({ id: dimension, label: t(`managedMachines.config.${dimension}`), value: flag ? `${flag} ${value}` : value });
    }
    // Saved launch choices are an object of field values; any other JSON shape has no field to present.
    // They stand in for the provider's own facts: once its native facts (current or last saved) describe the
    // configuration, the raw choices behind them would only repeat it in launch terms (a store path, an image URL).
    const savedChoices = input.launch.choices;
    const nativeDescribed = Boolean(size || nativeLabels.length || input.lastSaved?.size || input.lastSaved?.image);
    if (input.savedLaunchPresentation && !nativeDescribed && savedChoices !== null && typeof savedChoices === 'object' && !Array.isArray(savedChoices)) {
        const { schema, inputHints } = input.savedLaunchPresentation;
        const hints = deriveActionInputHints(schema, inputHints);
        const options = buildSessionActionFieldOptionsResolver({});
        for (const field of resolveEffectiveActionInputFields({ inputHints: hints }, savedChoices)) {
            // Only a declared title names a choice; a title derived from its schema key ("Disk Gi B") names nothing.
            if (!inputHints?.fields.some(hint => hint.path === field.path) && !declaredSchemaTitle(schema, field.path)) continue;
            const savedValue = readInputPath(savedChoices, field.path);
            if (savedValue === undefined || savedValue === null) continue;
            const presentation = resolveActionFieldPresentationForInput(field, savedChoices);
            if (!presentation || presentation.kind === 'text' && presentation.secure) continue;
            const value = presentation.kind === 'text' ? presentation.value : presentation.kind === 'toggle'
                ? t(presentation.value ? 'common.yes' : 'common.no')
                : formatActionInputFieldChoice(field, savedValue, options);
            if (value) rows.push({ id: `saved:${field.path}`, label: field.title, value });
        }
    }
    // A size titled with the machine's own name (a local VM) would repeat the receipt's heading.
    const describeSize = (fact: NativeSizeFact) => {
        const title = localized(fact.title);
        return title === input.launch.name ? managedSizeDimensions(fact).join(' · ') : describeManagedSize(title, fact);
    };
    const sizeSpec = size ? describeSize(size) : null;
    // Unreadable current facts keep the preset's last saved size and image, said as such (VD D6).
    const lastSaved = facts?.nativeFacts || !input.lastSaved ? null : [input.lastSaved.size ? describeSize(input.lastSaved.size) : null,
        input.lastSaved.image ? localized(input.lastSaved.image.title) : null].filter((part): part is string => Boolean(part)).join(' · ');
    // Lab receipt order: where and what, then who pays, who manages it and where it joins.
    const credentials = input.launch.credentials ?? [];
    for (const [index, credential] of credentials.entries()) {
        const id = `credential:${index}`;
        const account = input.credentialPresentations?.[id] ?? ('account' in credential ? presentQualifiedConnectedAccountTarget({
            target: { kind: 'account', account: credential.account }, accounts: [], groups: [], labelsByKey: {}, serviceTitle: null,
        }) : presentConnectedAccountPurposeTeamResource({ teamResource: credential, teamResources: [], serviceTitle: null }));
        // One account is simply "Account"; several are told apart by the purpose each one serves.
        rows.push({ id, label: credentials.length === 1 ? t('managedMachines.receipt.account')
            : `${buildQualifiedPluginContributionKey(credential.purpose.consumer)} · ${credential.purpose.purpose}`,
            value: account.primaryLabel });
    }
    const cost = resolveManagedConfigurationCost({ prices: facts?.prices, billing: facts?.billing ?? input.declaredBilling,
        provider: input.providerTitle });
    // A local machine runs on the computer that manages it, and its cost already says "Runs on" that computer (or pool):
    // that one line names it. A machine that runs elsewhere (a cloud guest) keeps its Managed from row.
    const runsOnLine = cost.kind === 'local' && !input.absent;
    if (input.managedBy !== 'account' && !runsOnLine && controllerName !== undefined) rows.push({ id: 'controller', label: t('managedMachines.config.managedFrom'), value: controllerName });
    rows.push(...managedAgentSignInReceiptFacts(input.agentSignIn));
    if (input.homeName) rows.push({ id: 'home', label: t('managedMachines.receipt.joins'), value: input.homeName });
    // The provider's native duration is a contract, not a Keep choice: a resource that only ends says when it
    // Ends (its declared title); one that stops says its Longest run, as a duration (lab af-config K).
    const duration = facts?.nativeFacts?.duration;
    if (duration && !(input.created && input.nativeLifetimePresented)) {
        const finite = facts?.retentionCapabilities.finiteOnly === true;
        nativeLabels.push(localized(duration.title));
        rows.push({ id: 'duration', label: finite ? t('managedRetention.ends') : t('managedMachines.receipt.longestRun'),
            value: finite ? localized(duration.title) : formatRetentionDuration(duration.afterMs) });
    }
    const preset = facts?.preset ?? input.preset;
    const presetLine = preset ? preset.name
        ? t('machinePresets.fromRevision', { name: preset.name, revision: preset.revision })
        : t('managedMachines.receipt.eachOne', { revision: preset.revision }) : null;
    // A created machine names its preset in the caption, where the lab puts it.
    // A preset's own receipt is captioned with its revision already; the row is for a machine about to be made from one.
    // The row is already labelled "Made from this preset", so its value is the preset alone (the caption says "Made from ...").
    if (preset && presetLine && !input.created && !input.caption) rows.push({ id: 'preset', label: t('machinePresets.madeFrom'),
        value: preset.name ? t('machinePresets.nameRevision', { name: preset.name, revision: preset.revision }) : presetLine });
    const identity = input.enrollmentIdentity;
    if (identity?.kind === 'dedicatedDaemonUser') rows.push(
        { id: 'administrator', label: t('managedMachines.identity.receiptAdministrator'), value: { none: t('managedMachines.identity.none'),
            ask: t('managedMachines.identity.ask'), preauthorized: t('managedMachines.identity.preauthorized') }[identity.adminAccessAtCreation] },
        { id: 'runs-as', label: t('managedMachines.identity.receiptRunsAs'), value: identity.username });
    else if (identity) rows.push({ id: 'runs-as', label: t('managedMachines.identity.receiptRunsAs'),
        value: t(identity.kind === 'guestProcess' ? 'managedMachines.identity.receiptSandbox' : 'managedMachines.identity.receiptYourAccount') });
    if (facts) {
        if (facts.nativeFacts?.monthlyCapStatus) rows.push({ id: 'monthly-cap', label: t('managedMachines.billing.monthlyCap'),
            value: t(facts.nativeFacts.monthlyCapStatus === 'none' ? 'managedMachines.billing.noMonthlyCap' : 'managedMachines.billing.unknownMonthlyCap') });
        if (!input.created && !input.keepEditedBelow) rows.push({ id: 'retention', label: t('managedRetention.keepIt'), value: describeRetentionPolicy(facts) });
        if (facts.retentionCapabilities.nativeExpiry && !input.created) {
            const expiry = facts.retentionCapabilities.nativeExpiry;
            rows.push({ id: 'native-expiry', label: t('managedRetention.keepIt'), value: t('managedRetention.nativeExpiry', {
                provider: input.providerTitle, time: expiry.kind === 'deadline' ? formatAsOfTime(expiry.at) : formatRetentionDuration(expiry.afterMs),
            }) });
        }
    }
    else if (input.presetPolicy && !input.created) {
        rows.push({ id: 'retention', label: t('managedRetention.keepIt'),
            value: input.presetPolicy.retention ? describeRetention(input.presetPolicy.retention) : t('managedRetention.defaults') });
        if (input.presetPolicy.wakeOnAcceptedMessage !== undefined) rows.push({ id: 'wake', label: t('managedRetention.wake'),
            value: t(input.presetPolicy.wakeOnAcceptedMessage ? 'managedRetention.wakeOn' : 'managedRetention.wakeOff') });
    }
    // Stopped storage is not a receipt row: Keep it's consequence says the stopped cost once, as a short rate (R6).
    const presentPrice = (price: NonNullable<ManagedConfigurationFactsV1['prices']>[number]) => ({ ...price,
        ...(price.label !== undefined ? { label: localized(price.label) } : {}) });
    const caption = input.caption ?? (input.created ? presetLine ?? t('managedMachines.receipt.asCreated') : t('managedMachines.receipt.yourNewMachine'));
    return { caption, mark: input.mark ?? null,
        name: input.launch.name, spec: sizeSpec ?? (nativeLabels.length ? nativeLabels.join(' · ')
            : lastSaved ? t('managedMachines.receipt.lastSaved', { facts: lastSaved })
                // A machine still named after its provider doesn't say the same words twice.
                : input.providerTitle && input.providerTitle !== input.launch.name ? input.providerTitle : ''), facts: rows,
        ...(facts?.setup ?? input.setup ? { setup: facts?.setup ?? input.setup } : {}),
        cost: input.absent ? null : cost.kind === 'price' ? { ...cost, provider: input.providerTitle ?? null,
            prices: [presentPrice(cost.prices[0]), ...cost.prices.slice(1).map(presentPrice)] }
            // An unnamed controller is "the computer that manages it" in the cost's sentences, never "Unknown".
            : cost.kind === 'local' ? describeLocalCost({ computer: input.pooledController ? input.pooledController.sentenceName
                : input.controllerName === null ? null : input.controllerName ?? t('managedMachines.receipt.managingComputer'), size,
                resources: input.created ? undefined : facts?.localResources, omitHeadroom: input.created === true || !!input.pooledController })
                // Without any billing fact no one can be named as the biller (a local VM is billed by no one).
                : cost };
}

/**
 * The phone's summary bar (lab `m-config` Ap): the chosen size, then the place for a cloud machine or
 * the system for a local one (the receipt's own lead fact), then what Keep it does. It reads the same
 * reviewed facts as the receipt; without any native dimension it says nothing of its own.
 */
export function describeManagedConfigurationSummary(facts: ManagedConfigurationFactsV1,
    localized: (value: PluginLocalizedStringV2) => string = fallbackLocalized): string | null {
    const dimensions = managedSummaryDimensions(facts, localized);
    return dimensions.length ? [...dimensions, describeRetention(facts.retention)].join(' · ') : null;
}

function fallbackLocalized(value: PluginLocalizedStringV2): string {
    return typeof value === 'string' ? value : value.fallback;
}

/** The size, then the system for a local machine or the place for a cloud one: the summary's native dimensions. */
function managedSummaryDimensions(facts: ManagedConfigurationFactsV1, localized: (value: PluginLocalizedStringV2) => string): string[] {
    const native = facts.nativeFacts;
    const lead = facts.billing.location === 'local' ? native?.image : native?.location;
    return [native?.size, lead].flatMap(fact => fact ? [localized(fact.title)] : []);
}

/**
 * A preset's line in the machine picker's New machine group (lab m-pick): the summary's reviewed size and place
 * when the preset carries them, then the Keep it rule the preset sets now. A preset that follows the defaults says
 * no rule of its own, so a rule captured at review never stands in for the current one.
 */
export function describeManagedPresetOffer(preset: Readonly<{
    reviewedFacts?: ManagedConfigurationFactsV1; retention?: MachineRetentionOverrideV1['retention']; wakeOnAcceptedMessage?: boolean;
}>, localized: (value: PluginLocalizedStringV2) => string = fallbackLocalized): string | undefined {
    const dimensions = preset.reviewedFacts ? managedSummaryDimensions(preset.reviewedFacts, localized) : [];
    const keep = preset.retention
        ? describeRetentionPolicy({ retention: preset.retention, wakeOnAcceptedMessage: preset.wakeOnAcceptedMessage === true }) : null;
    return [...dimensions, ...(keep ? [keep] : [])].join(' · ') || undefined;
}

/**
 * A preset offer's cost column (lab m-pick): "No bill" and the computer it runs on for a local machine, or the
 * provider's returned price with when it was read. Unpriced says nothing: the column never guesses a figure.
 */
export function presentManagedPresetCost(input: Readonly<{
    prices?: ManagedConfigurationFactsV1['prices']; billing?: BillingCapabilitiesV1; provider: string | null; runsOn?: string;
}>): Readonly<{ value: string; detail?: string }> | null {
    const cost = resolveManagedConfigurationCost({ prices: input.prices, billing: input.billing, provider: input.provider });
    if (cost.kind === 'unpriced') return null;
    const headline = presentManagedCost(cost);
    if (cost.kind === 'local') return { value: headline.value,
        ...(input.runsOn ? { detail: t('managedMachines.price.runsOn', { computer: input.runsOn }) } : {}) };
    return { value: `${headline.value} ${headline.unit}`, detail: formatPriceSource(cost.prices[0], null) };
}

/** Whether the launch schema itself titles the property at this field path. */
function declaredSchemaTitle(schema: JsonSchemaObject, path: string): boolean {
    let node: unknown = schema;
    for (const key of path.split('.')) {
        const properties = node && typeof node === 'object' ? (node as { properties?: unknown }).properties : undefined;
        node = properties && typeof properties === 'object' ? (properties as Record<string, unknown>)[key] : undefined;
    }
    const title = node && typeof node === 'object' ? (node as { title?: unknown }).title : undefined;
    return typeof title === 'string' && title.trim().length > 0;
}

type NativeSizeFact = NonNullable<NonNullable<ManagedConfigurationFactsV1['nativeFacts']>['size']>;

/** The labelled native dimensions a size declares, as the receipt says them: "4 cores", "8 GiB", "80 GiB". */
export function managedSizeDimensions(size: NativeSizeFact): string[] {
    return sharedManagedSizeDimensions(size, count => t('managedMachines.receipt.cores', { count }));
}

/** "CX32 · 4 cores · 8 GiB · 80 GiB": the size's name, then whichever dimensions it declares. */
export function describeManagedSize(title: string, size: NativeSizeFact): string {
    return describeSharedManagedSize(title, size, count => t('managedMachines.receipt.cores', { count }));
}

/**
 * Local resource disclosure: running guest CPU allocations against host topology when reported,
 * otherwise the selected size against measured free resources. Allocations never imply idle CPU.
 * Missing measurements remain unknown rather than drawing an invented share.
 */
function describeLocalCost(input: Readonly<{ computer: string | null; size?: NativeSizeFact; resources?: ManagedLocalResourceFactsV1;
    omitHeadroom: boolean }>): ManagedReceiptCost {
    const { computer, size, resources } = input;
    const meters: Extract<ManagedReceiptCost, { kind: 'local' }>['meters'][number][] = [];
    const cores = size?.cpuCores !== undefined && resources?.availableCpuCores !== undefined && resources.availableCpuCores > 0
        ? { used: size.cpuCores, free: resources.availableCpuCores } : null;
    const memory = size?.memoryBytes !== undefined && resources?.availableMemoryBytes !== undefined && resources.availableMemoryBytes > 0
        ? { used: size.memoryBytes, free: resources.availableMemoryBytes } : null;
    const disk = size?.diskBytes !== undefined && resources?.availableDiskBytes !== undefined
        ? { used: size.diskBytes, free: resources.availableDiskBytes } : null;
    if (resources?.totalCpuCores !== undefined && resources.totalCpuCores > 0 && resources.allocatedCpuCores !== undefined) {
        meters.push({ id: 'cpu', label: t('managedMachines.config.columns.cpu'),
            fraction: Math.min(1, resources.allocatedCpuCores / resources.totalCpuCores),
            value: t('managedMachines.receipt.coresAllocated', { allocated: String(resources.allocatedCpuCores), total: String(resources.totalCpuCores) }) });
    } else if (cores) meters.push({ id: 'cpu', label: t('managedMachines.config.columns.cpu'), fraction: Math.min(1, cores.used / cores.free),
        value: t('managedMachines.receipt.coresOfFree', { count: cores.used, free: String(cores.free) }) });
    if (memory) meters.push({ id: 'memory', label: t('managedMachines.config.columns.memory'), fraction: Math.min(1, memory.used / memory.free),
        value: t('managedMachines.receipt.amountOfFree', { amount: formatManagedSizeBytes(memory.used), free: formatManagedSizeBytes(memory.free) }) });
    if (disk) meters.push({ id: 'disk', label: t('managedMachines.config.columns.disk'),
        fraction: disk.free === 0 ? 1 : Math.min(1, disk.used / disk.free),
        value: t('managedMachines.receipt.amountOfFree', { amount: formatManagedSizeBytes(disk.used), free: formatManagedSizeBytes(disk.free) }) });
    if (input.omitHeadroom || computer === null) return { kind: 'local', computer, meters: input.omitHeadroom ? [] : meters };
    if (!cores && !memory && !disk) return { kind: 'local', computer, meters, note: t('managedMachines.receipt.headroomUnknown', { computer }) };
    if (cores && cores.used > cores.free || memory && memory.used > memory.free || disk && disk.used > disk.free) {
        return { kind: 'local', computer, meters, note: t('managedMachines.receipt.exceedsFree', { computer }) };
    }
    const leftCores = cores ? t('managedMachines.receipt.cores', { count: cores.free - cores.used }) : null;
    const leftMemory = memory ? formatManagedSizeBytes(memory.free - memory.used) : null;
    const leftDisk = disk ? formatManagedSizeBytes(disk.free - disk.used) : null;
    return { kind: 'local', computer, meters, note: leftCores && leftMemory
        ? t('managedMachines.receipt.leavesBoth', { cores: leftCores, memory: leftMemory, computer })
        : t('managedMachines.receipt.leavesOne', { amount: leftCores ?? leftMemory ?? leftDisk ?? '', computer }) };
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
    const disk = size.diskBytes !== undefined && resources.availableDiskBytes !== undefined ? resources.availableDiskBytes - size.diskBytes : null;
    if (cores === null && memory === null && disk === null) return undefined;
    if ((cores ?? 0) < 0 || (memory ?? 0) < 0 || (disk ?? 0) < 0) return t('managedMachines.config.notEnoughFree');
    return [cores === null ? null : t('managedMachines.receipt.cores', { count: cores }),
        memory === null ? null : formatManagedSizeBytes(memory),
        disk === null ? null : formatManagedSizeBytes(disk)].filter((part): part is string => part !== null).join(' · ');
}
