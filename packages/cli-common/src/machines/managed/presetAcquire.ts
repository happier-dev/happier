import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { ManagedMachinePresetContentV1Schema, ManagedMachinePresetLaunchNameOverrideV1Schema,
    ManagedMachinePresetStoredContentV1Schema, replaceManagedMachinePresetLaunchNameV1,
    resolveManagedMachinePresetAcquireOverrideV1, type ManagedMachinePresetContentV1,
    type ManagedMachinePresetLaunchNameOverrideV1, type ManagedMachinePresetNativeControlResultV1,
    type ManagedMachinePresetStoredContentCarrierV1, type ManagedMachinePresetStoredContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { ManagedMachineFullV1Schema, type ManagedMachineFullV1,
  type ManagedOpaquePresetMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { MachineProvisionerDestroyResultV1Schema, MachineProvisionerPowerResultV1Schema,
    MachineProvisionerRebuildResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import type { AcquireResultV1, ProviderObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { MachineSetupSourceFactsMapV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';

export type ManagedOpaquePresetContentOpenerV1 = (content: ManagedMachinePresetStoredContentV1) =>
  ManagedMachinePresetContentV1 | null | Promise<ManagedMachinePresetContentV1 | null>;

export type PreparedManagedOpaquePresetAcquireV1 = Readonly<{
    /** The authenticated carrier that the host later reseals with its immutable review. */
    content: ManagedMachinePresetStoredContentV1;
    /** Local-only full content; it never crosses the Home boundary. */
    opened: ManagedMachinePresetContentV1 & Readonly<{ launch: NonNullable<ManagedMachinePresetContentV1['launch']> }>;
    launchName: string;
}>;

/**
 * Classifies a private native intent result before the keyholding report
 * sealer retains it in the admitted preset snapshot. The Home-facing report
 * consumes only the protocol's structural projection of the same result.
 */
export function readManagedOpaquePresetNativeControlResultV1(machine: Pick<ManagedMachineFullV1, 'desired'>,
    value: unknown): ManagedMachinePresetNativeControlResultV1 | null {
    if (machine.desired === 'rebuild') {
        const result = MachineProvisionerRebuildResultV1Schema.safeParse(value);
        return result.success ? { kind: 'rebuild', result: result.data } : null;
    }
    if (machine.desired === 'delete') {
        const result = MachineProvisionerDestroyResultV1Schema.safeParse(value);
        return result.success ? { kind: 'delete', result: result.data } : null;
    }
    const result = MachineProvisionerPowerResultV1Schema.safeParse(value);
    return result.success ? { kind: 'power', intent: machine.desired, result: result.data } : null;
}

/**
 * The single keyholding report-seal owner shared by controller daemons and
 * Account-hosted execution. It retains private provider facts only in the
 * same admitted preset carrier; callers project structural report results
 * separately through the protocol owner.
 */
export function prepareManagedOpaquePresetReportV1(params: Readonly<{
    machine: ManagedOpaquePresetMachineV1;
    content: ManagedMachinePresetStoredContentCarrierV1;
    recipients: readonly unknown[];
    opened: ManagedMachinePresetContentV1 & Readonly<{ launch: NonNullable<ManagedMachinePresetContentV1['launch']> }>;
    accountId: string;
    accountKey?: Uint8Array;
    randomBytes: (length: number) => Uint8Array;
    reviewedFacts?: ManagedConfigurationFactsV1;
    nativeResult?: AcquireResultV1;
    observation?: ProviderObservationV1;
    nativeControlResult?: ManagedMachinePresetNativeControlResultV1;
    setupSourceFacts?: MachineSetupSourceFactsMapV1;
}>): Readonly<{ content: ManagedMachinePresetStoredContentV1; opened: ManagedMachinePresetContentV1 }> | null {
    if (params.accountId !== params.machine.custodianAccountId) return null;
    const content = ManagedMachinePresetStoredContentV1Schema.safeParse(params.content);
    if (!content.success) return null;
    const reviewedFacts = params.reviewedFacts ?? params.opened.reviewedFacts;
    // A bound Rebuild replaces the original acquisition identity. Preserve
    // that resource in the existing snapshot field before a later Delete
    // replaces the control result with its operation reference.
    const nativeResult = params.nativeResult ?? (params.nativeControlResult?.kind === 'rebuild'
        && params.nativeControlResult.result.kind === 'bound'
        ? { kind: 'bound' as const, resource: params.nativeControlResult.result.resource }
        : undefined);
    const mode = params.machine.preset.contentEncryptionMode;
    const replaced = mode === 'plain'
        ? replaceManagedMachinePresetLaunchNameV1({ presetId: params.machine.preset.id, mode, content: content.data,
            launchName: params.opened.launch.name, ...(reviewedFacts === undefined ? {} : { reviewedFacts }),
            ...(nativeResult === undefined ? {} : { nativeResult }),
            ...(params.observation === undefined ? {} : { observation: params.observation }),
            ...(params.nativeControlResult === undefined ? {} : { nativeControlResult: params.nativeControlResult }),
            ...(params.setupSourceFacts === undefined ? {} : { setupSourceFacts: params.setupSourceFacts }) })
        : params.accountKey === undefined ? null : replaceManagedMachinePresetLaunchNameV1({ presetId: params.machine.preset.id,
            mode, content: content.data, recipients: params.recipients, accountId: params.accountId, accountKey: params.accountKey,
            launchName: params.opened.launch.name, ...(reviewedFacts === undefined ? {} : { reviewedFacts }),
            ...(nativeResult === undefined ? {} : { nativeResult }),
            ...(params.observation === undefined ? {} : { observation: params.observation }),
            ...(params.nativeControlResult === undefined ? {} : { nativeControlResult: params.nativeControlResult }),
            ...(params.setupSourceFacts === undefined ? {} : { setupSourceFacts: params.setupSourceFacts }),
            randomBytes: params.randomBytes });
    if (!replaced) return null;
    const opened = ManagedMachinePresetContentV1Schema.safeParse({ ...params.opened, launch: params.opened.launch,
        ...(reviewedFacts === undefined ? {} : { reviewedFacts }),
        ...(nativeResult === undefined ? {} : { nativeResult }),
        ...(params.observation === undefined ? {} : { observation: params.observation }),
        ...(params.nativeControlResult === undefined ? {} : { nativeControlResult: params.nativeControlResult }),
        ...(params.setupSourceFacts === undefined ? {} : { setupSourceFacts: params.setupSourceFacts }) });
    return opened.success ? { content: replaced, opened: opened.data } : null;
}

/**
 * A control result is newer than the original acquire result whenever it
 * names a replacement resource or a terminal/recoverable delete state. Other
 * control effects operate on the same resource, so the original admitted
 * identity remains the local execution basis.
 */
function readLatestOpaquePresetNativeProjection(opened: ManagedMachinePresetContentV1) {
    const control = opened.nativeControlResult;
    if (control?.kind === 'rebuild') {
        if (control.result.kind === 'bound') return { resource: control.result.resource };
        if (control.result.kind === 'unknown') return { recovery: control.result.recovery };
    }
    if (control?.kind === 'delete') {
        // Home retains allocation `bound` until the accepted Delete settles.
        // Its private continuation therefore needs the latest sealed bound
        // resource and the new operation reference; dropping the former makes the
        // local full projection invalid before the observer can finish.
        if (control.result.kind === 'accepted') return {
            ...(opened.nativeResult?.kind === 'bound' ? { resource: opened.nativeResult.resource } : {}),
            nativeOperationRef: control.result.nativeOperationRef,
        };
        if (control.result.kind === 'confirmed') return {};
    }
    const native = opened.nativeResult;
    return native?.kind === 'bound' ? { resource: native.resource }
        : native?.kind === 'pending' ? { nativeOperationRef: native.nativeOperationRef }
            : native?.kind === 'unknown' ? { recovery: native.recovery } : {};
}

/**
 * A host-local full view is the only presentation/execution form of an opaque
 * row. The structural row stays exactly server-shaped; this helper never
 * serializes or mutates it.
 */
export function hydrateManagedOpaquePresetMachineV1(params: Readonly<{
    machine: ManagedOpaquePresetMachineV1;
    opened: ManagedMachinePresetContentV1;
}>): ManagedMachineFullV1 | null {
    if (!params.opened.launch) return null;
    const machineSetup = params.machine.machineSetup === undefined ? undefined
        : params.opened.setup === undefined ? null : { ...params.machine.machineSetup, setup: params.opened.setup,
            ...(params.opened.setupSourceFacts === undefined ? {} : { sourceFacts: params.opened.setupSourceFacts }) };
    if (machineSetup === null) return null;
    // Native identity and detailed observations are sealed with the admitted
    // snapshot. They are restored only in this local keyholding projection;
    // callers must re-project the structural row before any Home response.
    const nativeProjection = readLatestOpaquePresetNativeProjection(params.opened);
    const full = ManagedMachineFullV1Schema.safeParse({ ...params.machine, ...nativeProjection, launch: params.opened.launch,
        ...(params.opened.enrollmentIdentity === undefined ? {} : { enrollmentIdentity: params.opened.enrollmentIdentity }),
        ...(params.opened.reviewedFacts === undefined ? {} : { reviewedFacts: params.opened.reviewedFacts }),
        ...(params.opened.observation === undefined ? {} : { observation: params.opened.observation }),
        ...(machineSetup === undefined ? {} : { machineSetup }) });
    return full.success ? full.data : null;
}

/**
 * The Account keyholding host is the one owner of an opaque preset's initial
 * Machine name. An optional sealed override may change only that name; absent
 * an override, each new Machine receives the selected provider's own label.
 */
export async function prepareManagedOpaquePresetAcquireV1(params: Readonly<{
    content: unknown;
    override?: unknown;
    provisioner: Pick<MachineProvisionerContributionV1, 'id' | 'title'>;
    open: ManagedOpaquePresetContentOpenerV1;
}>): Promise<PreparedManagedOpaquePresetAcquireV1 | null> {
    const baseCarrier = ManagedMachinePresetStoredContentV1Schema.safeParse(params.content);
    if (!baseCarrier.success) return null;
    const base = await params.open(baseCarrier.data);
    if (!base?.launch) return null;

    let carrier = baseCarrier.data;
    let opened = { ...base, launch: base.launch };
    let launchName = base.launch.name;
    if (params.override !== undefined) {
        const override = ManagedMachinePresetLaunchNameOverrideV1Schema.safeParse(params.override);
        if (!override.success) return null;
        const overrideCarrier = ManagedMachinePresetStoredContentV1Schema.safeParse(override.data.content);
        if (!overrideCarrier.success) return null;
        const overrideContent = await params.open(overrideCarrier.data);
        if (!overrideContent?.launch) return null;
        const resolved = resolveManagedMachinePresetAcquireOverrideV1({ baseContent: base, overrideContent });
        if (!resolved) return null;
        carrier = overrideCarrier.data;
        opened = { ...overrideContent, launch: overrideContent.launch };
        launchName = resolved.launchName ?? (base.reviewedFacts === undefined
            ? resolvePluginLocalizedStringV2Text(params.provisioner.title).trim() || params.provisioner.id : opened.launch.name);
    } else if (base.reviewedFacts === undefined) {
        // `title` is the selected host declaration's localized display value;
        // `id` remains the canonical non-empty fallback for a malformed label.
        launchName = resolvePluginLocalizedStringV2Text(params.provisioner.title).trim() || params.provisioner.id;
    }
    const full = ManagedMachinePresetContentV1Schema.safeParse({ ...opened,
        launch: { ...opened.launch, name: launchName } });
    if (!full.success || !full.data.launch) return null;
    return { content: carrier, opened: { ...full.data, launch: full.data.launch }, launchName };
}

export type { ManagedMachinePresetLaunchNameOverrideV1 };
