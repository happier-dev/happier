import { executeManagedMachineAcquire, reconcileManagedMachine, createManagedNativeBootstrapIO,
    createManagedNativeObservationWait, hydrateManagedOpaquePresetMachineV1, prepareManagedOpaquePresetAcquireV1,
    prepareManagedOpaquePresetReportV1, qualifyManagedOpaquePresetProvisionerV1, readManagedGuestDiagnostics,
    readManagedOpaquePresetNativeControlResultV1,
    ManagedMachineControllerError } from '@happier-dev/cli-common/machines/managed';
import { resolveMachineRetentionPolicyV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { GuestCliIdentityV1 } from '@happier-dev/protocol/features';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { ManagedControllerContextOutputV1Schema, ManagedControllerIntentReportV1Schema,
    projectManagedOpaquePresetAcquireResultV1, projectManagedOpaquePresetIntentResultV1,
    projectManagedOpaquePresetResizeResultV1, type ManagedAcquireInputV1, type ManagedControllerResizeReportV1,
    isManagedPresetAcquireInputV1, type ManagedAdmissionOutputV1,
    type ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedConfigurationFactsV1Schema, type ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { isManagedOpaquePresetMachineV1, resolveManagedMachineEnrollmentAdminAccessV1,
    resolveManagedMachineEnrollmentAgentIsolationV1, type ManagedMachineV1, type ManagedMachineFullV1,
    type ManagedOpaquePresetMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachinePresetStoredContentV1Schema, projectManagedMachinePresetForRecipientV1,
    readManagedMachinePresetContentOverrideForModeV1, resolveManagedMachinePresetResizeOverrideV1,
    type ManagedMachinePresetNativeControlResultV1, type ManagedMachinePresetStoredContentCarrierV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { AcquireResultV1Schema, projectManagedOpaquePresetObservationV1,
    ProviderObservationV1Schema, type AcquireResultV1, type ProviderObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { MachineProvisionerResizeResultV1Schema, type MachineProvisionerSizeV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readRuntimeFetchHost } from '@/utils/system/runtimeFetch';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { readMachineProvisionerHostAvailability } from '@happier-dev/cli-common/machines/managed/provisioners';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';
import { resolveDefaultNativeSshSystemTaskCapability } from '@/components/systemTasks/bridges/native';
import { createUiManagedAccountCredential } from './managedMachineAccountCredential';
import { readUiManagedProvisioners } from '@/sync/ops/actions/managedProvisionerAction';
import { captureManagedMachinePresetCustodyV1 } from '@/sync/ops/machines/managedMachinePresetCustody';
import { createUiManagedAccountNative, readUiManagedAccountAdmission, type UiManagedAccountNativeAdmission,
} from './managedMachineAccountNative';
import { admitUiManagedAccountHome, createUiManagedAccountHome, createUiManagedAccountHomeRequest, normalizeUiManagedAccountMachine,
    type UiManagedAccountMachineNormalizer } from './managedMachineAccountHome';
import { completeUiManagedAccountGuest } from './managedMachineAccountGuest';
import { runUiManagedMachineEnrollment, readUiManagedMachineEnrollmentCapabilities,
    type UiManagedMachineEnrollmentDependencies } from './managedMachineEnrollment';
import { createMachinePresetActionClient } from './managedMachinePresets';

type UiManagedAccountRecipeParams = Readonly<{
    account: LazyActionAccountContext;
    context: ActionExecutorContext;
    requestId: string;
    input: ManagedAcquireInputV1 | ManagedMachineActionInputV1<'machines.managed.bootstrap.retry'>;
    signal?: AbortSignal;
    installNativePayload?: UiManagedMachineEnrollmentDependencies['installNativePayload'];
    retryGuestCli?: GuestCliIdentityV1;
}>;

/** The Home carrier remains opaque until this captured Account opens its exact admitted snapshot. */
export type UiManagedOpaquePresetCarrier = Readonly<{
    machine: ManagedOpaquePresetMachineV1;
    presetContent: Extract<ManagedAdmissionOutputV1, { presetContent: unknown }>['presetContent'];
    presetContentOverride?: Extract<ManagedAdmissionOutputV1, { presetContent: unknown }>['presetContentOverride'];
}>;

export type UiManagedOpaquePresetHydration = Readonly<{
    machine: ManagedMachineFullV1;
    admission: UiManagedAccountNativeAdmission;
    normalizer: UiManagedAccountMachineNormalizer;
    prepareResize(override: unknown): Readonly<{ machine: ManagedMachineFullV1; size: MachineProvisionerSizeV1 }>;
    prepareResizeReport(body: unknown): Extract<ManagedControllerResizeReportV1, { presetContent: unknown }> | null;
    dispose(): void;
}>;

export function isUiManagedOpaquePresetCarrier(value: Readonly<{ machine: ManagedMachineV1 }>): value is UiManagedOpaquePresetCarrier {
    return isManagedOpaquePresetMachineV1(value.machine) && 'presetContent' in value;
}

function matchesUiManagedOpaquePresetSnapshot(machine: ManagedMachineV1, carrier: UiManagedOpaquePresetCarrier):
    machine is ManagedOpaquePresetMachineV1 {
    const source = carrier.machine;
    return isManagedOpaquePresetMachineV1(machine)
        && machine.id === source.id
        && machine.homeId === source.homeId
        && machine.custodianAccountId === source.custodianAccountId
        && machine.preset.id === source.preset.id
        && machine.preset.revision === source.preset.revision
        && machine.preset.contentEncryptionMode === source.preset.contentEncryptionMode;
}

type UiManagedOpaquePresetSnapshot = Pick<ManagedMachinePresetV1, 'id' | 'contentEncryptionMode' | 'content' | 'recipients'>;

async function prepareUiManagedOpaquePreset(params: Readonly<{
    account: LazyActionAccountContext;
    preset: UiManagedOpaquePresetSnapshot;
    signal?: AbortSignal;
}>) {
    const custody = await captureManagedMachinePresetCustodyV1({ account: params.account,
        resourceMode: params.preset.contentEncryptionMode, signal: params.signal });
    if (!custody) throw new ManagedMachineControllerError('content_unavailable');
    try {
        const open = (content: ManagedMachinePresetStoredContentCarrierV1, snapshot: UiManagedOpaquePresetSnapshot) => custody.open({
            presetId: snapshot.id, mode: snapshot.contentEncryptionMode,
            projection: projectManagedMachinePresetForRecipientV1({ content, recipients: snapshot.recipients, recipientAccountId: custody.accountId }),
        });
        const base = ManagedMachinePresetStoredContentV1Schema.safeParse(params.preset.content);
        if (!base.success) throw new ManagedMachineControllerError('content_unavailable');
        const baseOpened = open(base.data, params.preset);
        if (!baseOpened?.launch) throw new ManagedMachineControllerError('content_unavailable');
        const provisioners = await readUiManagedProvisioners(params.account, baseOpened.launch.provider.pluginId);
        if ('ok' in provisioners) throw new ManagedMachineControllerError(provisioners.errorCode);
        const provisioner = qualifyManagedOpaquePresetProvisionerV1({ launch: baseOpened.launch, provisioners });
        if (!provisioner) throw new ManagedMachineControllerError('provider_unavailable');
        const prepare = async (snapshot: UiManagedOpaquePresetSnapshot, contentOverride?: unknown) => {
            const override = contentOverride === undefined ? undefined
                : readManagedMachinePresetContentOverrideForModeV1({ mode: snapshot.contentEncryptionMode,
                    override: contentOverride });
            if (contentOverride !== undefined && !override) throw new ManagedMachineControllerError('content_unavailable');
            const prepared = await prepareManagedOpaquePresetAcquireV1({ content: snapshot.content, override, provisioner,
                open: content => open(content, snapshot) });
            if (!prepared) throw new ManagedMachineControllerError('content_unavailable');
            return prepared;
        };
        return { custody, provisioner, prepare, open };
    } catch (error) {
        custody.dispose();
        throw error;
    }
}

/**
 * The Account custody edge is the sole place that projects, opens, qualifies,
 * and locally hydrates the exact admission/context snapshot. Home receives
 * only structural rows again through the returned normalizer.
 */
export async function hydrateUiManagedOpaquePreset(params: Readonly<{
    account: LazyActionAccountContext;
    carrier: UiManagedOpaquePresetCarrier;
    preparation?: Awaited<ReturnType<typeof prepareUiManagedOpaquePreset>>;
    signal?: AbortSignal;
}>): Promise<UiManagedOpaquePresetHydration> {
    if (params.account.accountId !== params.carrier.machine.custodianAccountId) {
        throw new ManagedMachineControllerError('content_unavailable');
    }
    const snapshot = { id: params.carrier.machine.preset.id,
        contentEncryptionMode: params.carrier.machine.preset.contentEncryptionMode, ...params.carrier.presetContent };
    const preparation = params.preparation ?? await prepareUiManagedOpaquePreset({
        account: params.account, preset: snapshot, signal: params.signal,
    });
    const { custody, provisioner } = preparation;
    try {
        // The admitted/replayed snapshot owns native resource facts and the
        // original per-Machine override; the source Preset does not.
        const prepared = await preparation.prepare(snapshot, params.carrier.presetContentOverride);
        const open = (content: ManagedMachinePresetStoredContentCarrierV1) => preparation.open(content, snapshot);
        let content: ManagedMachinePresetStoredContentCarrierV1 = prepared.content;
        let opened = prepared.opened;
        let latestStructural = params.carrier.machine;
        const normalize = (machine: ManagedMachineV1): ManagedMachineFullV1 | null => {
            if (!matchesUiManagedOpaquePresetSnapshot(machine, params.carrier)) return null;
            const hydrated = hydrateManagedOpaquePresetMachineV1({ machine, opened });
            if (!hydrated) return null;
            latestStructural = machine;
            return hydrated;
        };
        const machine = normalize(params.carrier.machine);
        if (!machine) throw new ManagedMachineControllerError('content_unavailable');
        const reseal = (details: Readonly<{
            reviewedFacts?: ManagedConfigurationFactsV1;
            nativeResult?: AcquireResultV1;
            observation?: ProviderObservationV1;
            nativeControlResult?: ManagedMachinePresetNativeControlResultV1;
        }>) => {
            params.signal?.throwIfAborted();
            params.account.assertCurrent();
            const seal = (accountKey?: Uint8Array) => prepareManagedOpaquePresetReportV1({
                machine: latestStructural, content, recipients: params.carrier.presetContent.recipients, opened,
                accountId: custody.accountId, ...(accountKey === undefined ? {} : { accountKey }), randomBytes: getRandomBytes,
                ...(details.reviewedFacts === undefined ? {} : { reviewedFacts: details.reviewedFacts }),
                ...(details.nativeResult === undefined ? {} : { nativeResult: details.nativeResult }),
                ...(details.observation === undefined ? {} : { observation: details.observation }),
                ...(details.nativeControlResult === undefined ? {} : { nativeControlResult: details.nativeControlResult }),
            });
            const sealed = custody.mode === 'e2ee'
                ? custody.withAccountKey(({ accountKey }) => seal(accountKey)) : seal();
            if (!sealed?.opened.launch) return null;
            content = sealed.content;
            opened = { ...sealed.opened, launch: sealed.opened.launch };
            return sealed;
        };
        const prepareResize = (override: unknown): Readonly<{ machine: ManagedMachineFullV1; size: MachineProvisionerSizeV1 }> => {
            const parsed = readManagedMachinePresetContentOverrideForModeV1({
                mode: params.carrier.machine.preset.contentEncryptionMode, override,
            });
            if (!parsed) throw new ManagedMachineControllerError('content_unavailable');
            const openedOverride = open(parsed.content);
            const size = resolveManagedMachinePresetResizeOverrideV1({ baseContent: opened, overrideContent: openedOverride });
            if (!size || !openedOverride?.launch) throw new ManagedMachineControllerError('content_unavailable');
            content = parsed.content;
            opened = { ...openedOverride, launch: openedOverride.launch };
            const local = normalize(latestStructural);
            if (!local) throw new ManagedMachineControllerError('content_unavailable');
            return { machine: local, size };
        };
        const prepareResizeReport = (body: unknown): Extract<ManagedControllerResizeReportV1, { presetContent: unknown }> | null => {
            if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
            const report = body as Readonly<Record<string, unknown>>;
            if (report.homeId !== latestStructural.homeId || report.managedId !== latestStructural.id
                || typeof report.requestId !== 'string') return null;
            const result = MachineProvisionerResizeResultV1Schema.safeParse(report.result);
            if (!result.success) return null;
            const observation = report.observation === undefined ? undefined : ProviderObservationV1Schema.safeParse(report.observation);
            if (observation !== undefined && !observation.success) return null;
            const sealed = reseal({ nativeControlResult: { kind: 'resize', result: result.data },
                ...(observation?.success ? { observation: observation.data } : {}) });
            if (!sealed) return null;
            return {
                homeId: latestStructural.homeId, managedId: latestStructural.id, requestId: report.requestId,
                result: projectManagedOpaquePresetResizeResultV1(result.data), presetContent: sealed.content,
                ...(observation?.success ? { observation: projectManagedOpaquePresetObservationV1(observation.data) } : {}),
            };
        };
        const normalizer: UiManagedAccountMachineNormalizer = {
            normalize,
            structural: local => local.id === params.carrier.machine.id
                && local.homeId === params.carrier.machine.homeId
                && local.custodianAccountId === params.carrier.machine.custodianAccountId
                && local.preset?.id === params.carrier.machine.preset.id
                && local.preset.revision === params.carrier.machine.preset.revision
                && local.preset.contentEncryptionMode === params.carrier.machine.preset.contentEncryptionMode
                ? latestStructural : null,
            prepareHomeRequest: (path, body) => {
                if (path === 'report-resize') return prepareResizeReport(body);
                if (path !== 'report' && path !== 'report-intent') return undefined;
                if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
                const report = body as Readonly<Record<string, unknown>>;
                if (report.homeId !== latestStructural.homeId || report.managedId !== latestStructural.id
                    || report.expectedIntentRevision !== latestStructural.intentRevision || typeof report.requestId !== 'string') return null;
                const observation = report.observation === undefined ? undefined : ProviderObservationV1Schema.safeParse(report.observation);
                if (observation !== undefined && !observation.success) return null;
                if (path === 'report-intent') {
                    const nativeControlResult = readManagedOpaquePresetNativeControlResultV1(latestStructural, report.result);
                    if (!nativeControlResult) return null;
                    const sealed = reseal({ nativeControlResult,
                        ...(observation?.success ? { observation: observation.data } : {}) });
                    if (!sealed) return null;
                    const preparedReport = ManagedControllerIntentReportV1Schema.safeParse({ ...report,
                        result: projectManagedOpaquePresetIntentResultV1(nativeControlResult.result),
                        presetContent: sealed.content,
                        ...(observation?.success ? { observation: projectManagedOpaquePresetObservationV1(observation.data) } : {}),
                    });
                    return preparedReport.success ? preparedReport.data : null;
                }
                const result = AcquireResultV1Schema.safeParse(report.result);
                if (!result.success) return null;
                const reviewedFacts = report.configurationFacts === undefined ? undefined
                    : ManagedConfigurationFactsV1Schema.safeParse(report.configurationFacts);
                if (reviewedFacts !== undefined && !reviewedFacts.success) return null;
                const sealed = reseal({ ...(reviewedFacts?.success ? { reviewedFacts: reviewedFacts.data } : {}),
                    nativeResult: result.data, ...(observation?.success ? { observation: observation.data } : {}) });
                if (!sealed) return null;
                return {
                    homeId: latestStructural.homeId, managedId: latestStructural.id,
                    expectedIntentRevision: latestStructural.intentRevision, requestId: report.requestId,
                    result: projectManagedOpaquePresetAcquireResultV1(result.data), presetContent: sealed.content,
                    ...(report.bootstrapInstalled === true ? { bootstrapInstalled: true as const } : {}),
                    ...(observation?.success ? { observation: projectManagedOpaquePresetObservationV1(observation.data) } : {}),
                };
            },
        };
        return { machine, admission: { provisioner, providerPluginId: machine.launch.provider.pluginId }, normalizer,
            prepareResize, prepareResizeReport, dispose: custody.dispose };
    } catch (error) {
        custody.dispose();
        throw error;
    }
}

function readUiManagedAccountRequestEnvelopeDigest(params: Omit<UiManagedAccountRecipeParams, 'input'>,
    input: ManagedAcquireInputV1): string {
    return params.context.externalActionExecutionAuthorization?.binding.requestEnvelopeDigest
        ?? computeExternalActionRequestEnvelopeDigestV1(params.context.originalActionEnvelope ?? ExternalActionRequestEnvelopeV1Schema.parse({
            v: 1, requestId: params.requestId, input,
        }));
}

/** Foreground Account work owns no fictitious Machine Action operation. */
export async function executeUiManagedAccountAcquire(params: Omit<UiManagedAccountRecipeParams, 'input'> & Readonly<{
    input: ManagedAcquireInputV1;
    presetSnapshot?: ManagedMachinePresetV1;
}>) {
    const host = await readRuntimeFetchHost(params.account.endpointUrl);
    const features = await getServerFeaturesSnapshot({ serverId: params.account.serverId, signal: params.signal });
    const delivery = readMachineProvisionerHostAvailability({ host,
        guestCli: features.status === 'ready' ? features.features.capabilities.guestCli : undefined,
        ...readUiManagedMachineEnrollmentCapabilities(params) });
    if (!delivery.available) throw new ManagedMachineControllerError(delivery.code ?? 'provider_unavailable');
    if (!isManagedPresetAcquireInputV1(params.input)) {
        const admitted = readUiManagedAccountAdmission(params.context);
        const client = createUiManagedAccountHome({ ...params, provisioner: admitted.provisioner });
        const acquired = await executeManagedMachineAcquire({
            host, provisioner: admitted.provisioner,
            admit: () => client.admit(admitted.input, readUiManagedAccountRequestEnvelopeDigest(params, admitted.input)),
            onAccepted: () => {},
            run: machine => runUiManagedAccountRecipe(params, admitted, client, machine, 'machines.managed.acquire'),
        });
        return { managedId: acquired.result.id };
    }

    let preparation: Awaited<ReturnType<typeof prepareUiManagedOpaquePreset>> | undefined;
    let opaque: UiManagedOpaquePresetHydration | undefined;
    try {
        let qualification: Parameters<typeof admitUiManagedAccountHome>[3];
        const delegated = params.context.externalActionExecutionAuthorization?.binding.managedAcquireDelegation === true;
        if (delegated || params.input.retention === undefined || params.input.wakeOnAcceptedMessage === undefined) {
            // Keep the original envelope intact: Home binds this native policy to
            // the same admitted public compute input, including encrypted roots.
            if (params.context.externalActionExecutionAuthorization && !params.context.originalActionEnvelope) {
                throw new ManagedMachineControllerError('admission_unavailable');
            }
            let preset = params.presetSnapshot;
            if (!preset) {
                const read = await createMachinePresetActionClient({ request: params.account.request }).execute('machines.presets.get', {
                    homeId: params.input.selection.homeId, id: params.input.selection.id,
                }, { signal: params.signal });
                if (read.kind !== 'found') throw new ManagedMachineControllerError(read.code);
                preset = read.preset;
            }
            if (preset.revision !== params.input.selection.revision) throw new ManagedMachineControllerError('request_conflict');
            preparation = await prepareUiManagedOpaquePreset({ account: params.account, preset, signal: params.signal });
            await preparation.prepare(preset, params.input.presetContentOverride);
            const policy = resolveMachineRetentionPolicyV1({ billing: preparation.provisioner.billing,
                nativeCapabilities: preparation.provisioner.retention, presetOverride: preset,
                ...(delegated ? {} : { machineOverride: { retention: params.input.retention,
                    wakeOnAcceptedMessage: params.input.wakeOnAcceptedMessage } }) });
            qualification = { presetPolicy: { retention: policy.retention, wakeOnAcceptedMessage: policy.wakeOnAcceptedMessage },
                originalActionEnvelope: params.context.originalActionEnvelope ?? ExternalActionRequestEnvelopeV1Schema.parse({
                    v: 1, requestId: params.requestId, input: params.input,
                }) };
        }
        const output = await admitUiManagedAccountHome(params, params.input,
            readUiManagedAccountRequestEnvelopeDigest(params, params.input), qualification);
        if (!isUiManagedOpaquePresetCarrier(output)) {
            const machine = normalizeUiManagedAccountMachine(undefined, output.machine);
            const admitted = readUiManagedAccountAdmission(params.context, machine);
            const client = createUiManagedAccountHome({ ...params, provisioner: admitted.provisioner });
            const acquired = await executeManagedMachineAcquire({
                host, provisioner: admitted.provisioner,
                admit: async () => machine,
                onAccepted: () => {},
                run: machine => runUiManagedAccountRecipe(params, admitted, client, machine, 'machines.managed.acquire'),
            });
            return { managedId: acquired.result.id };
        }
        const hydrated = await hydrateUiManagedOpaquePreset({ account: params.account, carrier: output, signal: params.signal,
            ...(preparation ? { preparation } : {}) });
        opaque = hydrated;
        const client = createUiManagedAccountHome({ ...params, provisioner: hydrated.admission.provisioner,
            normalizer: hydrated.normalizer });
        const acquired = await executeManagedMachineAcquire({
            host, provisioner: hydrated.admission.provisioner,
            admit: async () => hydrated.machine,
            onAccepted: () => {},
            run: machine => runUiManagedAccountRecipe(params, hydrated.admission, client, machine, 'machines.managed.acquire', hydrated.normalizer),
        });
        return { managedId: acquired.result.id };
    } finally {
        if (opaque) opaque.dispose();
        else preparation?.custody.dispose();
    }
}

/** Home returns the retained creation correlation before the same native recipe resumes. */
export async function executeUiManagedAccountRecovery(params: Omit<UiManagedAccountRecipeParams, 'input'> & Readonly<{
    action: 'machines.managed.inspect' | 'machines.managed.bootstrap.retry';
    input: ManagedMachineActionInputV1<'machines.managed.inspect'> | ManagedMachineActionInputV1<'machines.managed.bootstrap.retry'>;
    machine: ManagedMachineV1;
}>) {
    const retained = await createUiManagedAccountHomeRequest(params)('context', {
        homeId: params.machine.homeId, managedId: params.machine.id,
        expectedIntentRevision: 'expectedIntentRevision' in params.input ? params.input.expectedIntentRevision : params.machine.intentRevision,
    }, ManagedControllerContextOutputV1Schema);
    const recipe = { ...params, requestId: retained.requestId, retryGuestCli: retained.guestCli };
    const opaque = isUiManagedOpaquePresetCarrier(retained)
        ? await hydrateUiManagedOpaquePreset({ account: params.account, carrier: retained, signal: params.signal }) : null;
    try {
        const retainedMachine = opaque?.machine ?? normalizeUiManagedAccountMachine(undefined, retained.machine);
        const admitted = opaque?.admission ?? readUiManagedAccountAdmission(params.context, retainedMachine);
        const client = createUiManagedAccountHome({ ...recipe, provisioner: admitted.provisioner,
            ...(opaque ? { normalizer: opaque.normalizer } : {}) });
        const machine = await runUiManagedAccountRecipe(recipe, admitted, client, retainedMachine, params.action,
            opaque?.normalizer);
        if (params.action !== 'machines.managed.inspect') return { managedId: machine.id };
        const structural = client.structural(machine);
        if (!structural) throw new ManagedMachineControllerError('content_unavailable');
        if (!('includeGuestDiagnostics' in params.input) || !params.input.includeGuestDiagnostics) return { machine: structural };
        const guestDiagnostics = await readManagedGuestDiagnostics({ machine, requesterAccountId: params.account.accountId,
            requestId: retained.requestId,
            transport: admitted.provisioner.bootstrapTransport, channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(), signal: params.signal,
            native: { exec: request => {
                const credential = createUiManagedAccountCredential({ account: params.account, home: client.home, signal: params.signal });
                const native = createUiManagedAccountNative(recipe, admitted, () => machine, () => undefined, credential);
                return createManagedNativeBootstrapIO({ resource: machine.resource! }, native.invoke).exec(request);
            } },
        });
        return { machine: structural, guestDiagnostics };
    } finally {
        opaque?.dispose();
    }
}

function runUiManagedAccountRecipe(params: Omit<UiManagedAccountRecipeParams, 'input'> & {
    input: UiManagedAccountRecipeParams['input'] | ManagedMachineActionInputV1<'machines.managed.inspect'>;
}, admitted: UiManagedAccountNativeAdmission, client: ReturnType<typeof createUiManagedAccountHome>,
machine: ManagedMachineFullV1, action: 'machines.managed.acquire' | 'machines.managed.inspect' | 'machines.managed.bootstrap.retry',
normalizer?: UiManagedAccountMachineNormalizer) {
    const credential = createUiManagedAccountCredential({ account: params.account, home: client.home, signal: params.signal });
    return reconcileManagedMachine({
            machine, action, requestId: params.requestId, signal: params.signal,
            provisioner: admitted.provisioner, home: client.home,
            settleBootstrapFailure: retained => retained,
            createNative: (readMachine, readRevision) => createUiManagedAccountNative(params, admitted, readMachine, readRevision, credential),
            waitForObservation: createManagedNativeObservationWait(params.signal),
            bootstrap: {
                preflight: async () => {
                    const kind = admitted.provisioner.bootstrapCredential?.kind
                        ?? (admitted.provisioner.bootstrapTransport ? undefined : 'ssh');
                    if (kind === 'native-token' || kind === 'ssh' && !resolveDefaultNativeSshSystemTaskCapability().available) {
                        throw new ManagedMachineControllerError('provider_unavailable');
                    }
                    // These demanded guest effects need the ordinary retained
                    // managedContinuation transport; never accept and omit them.
                    const creation = 'selection' in params.input && !isManagedPresetAcquireInputV1(params.input) ? params.input : machine;
                    if (creation.reviewedFacts?.setup !== undefined
                        || resolveManagedMachineEnrollmentAdminAccessV1(creation.enrollmentIdentity)
                        || resolveManagedMachineEnrollmentAgentIsolationV1(creation.enrollmentIdentity)) {
                        throw new ManagedMachineControllerError('admission_unavailable');
                    }
                },
                prepareCredential: credential.prepare,
                readCredential: credential.read,
                complete: async row => {
                    if ('selection' in params.input || !machine.enrolledMachineId) {
                        await completeUiManagedAccountGuest({ ...params,
                            input: 'selection' in params.input ? params.input : {}, machine: row,
                            ...(normalizer ? { normalizer } : {}) });
                    }
                },
                enroll: async enrollment => {
                    if (!('selection' in params.input) && !('expectedIntentRevision' in params.input)) {
                        throw new ManagedMachineControllerError('admission_unavailable');
                    }
                    const target = await params.account.resolveHomeTarget();
                    await runUiManagedMachineEnrollment({
                        replacePayload: action === MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1,
                        ...(params.retryGuestCli ? { guestCli: params.retryGuestCli } : {}),
                        correlation: enrollment.correlation, homeCorrelation: enrollment.homeCorrelation,
                        carrier: enrollment.carrier, target,
                        channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(), operationId: params.context.operationAcceptance?.operationId ?? params.requestId,
                        onInstalled: enrollment.onInstalled,
                        credentials: params.account.credentials, context: params.context, reviewedAction: params.input, signal: params.signal,
                        ...(enrollment.guestHostPublicKey ? { guestHostPublicKey: enrollment.guestHostPublicKey } : {}),
                    }, {
                        readCurrentManagedRow: () => client.home.row('current', client.home.correlation(enrollment.machine)),
                        native: createManagedNativeBootstrapIO(enrollment.correlation, enrollment.invoke),
                        readBootstrapCredential: async () => (await credential.read(enrollment.machine, enrollment.credentialRevision)).value,
                        ...(params.installNativePayload ? { installNativePayload: params.installNativePayload } : {}),
                    });
                    // Ordinary Account pairing is the enrollment writer; observe its
                    // resulting row once, rather than inventing an /enrolled mutation.
                    const machine = await client.home.row('current', client.home.correlation(enrollment.machine));
                    return machine;
                },
            },
        });
}
