import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { MachineSetupSourceFactsMapV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createAccountScopedCryptoMaterialSnapshotV1, deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { ManagedMachineFullV1Schema, isManagedOpaquePresetMachineV1,
    type ManagedMachineFullV1, type ManagedMachineV1, type ManagedOpaquePresetMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachinePresetContentV1Schema, ManagedMachinePresetStoredContentV1Schema, openManagedMachinePresetContentV1,
    openManagedMachinePresetRecipientProjectionV1, readManagedMachinePresetContentOverrideForModeV1,
    resolveManagedMachinePresetResizeOverrideV1,
    type ManagedMachinePresetContentV1, type ManagedMachinePresetNativeControlResultV1,
    type ManagedMachinePresetStoredContentCarrierV1, type ManagedMachinePresetStoredContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { ManagedConfigurationFactsV1Schema, type ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { AcquireResultV1Schema, ProviderObservationV1Schema, projectManagedOpaquePresetObservationV1,
    type AcquireResultV1, type MachineProvisionerSizeV1, type ProviderObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { ManagedAcquireInputV1Schema, ManagedResizeOutputV1Schema, isManagedOpaquePresetReadV1, isManagedPresetAcquireInputV1,
    projectManagedOpaquePresetAcquireResultV1, projectManagedOpaquePresetIntentResultV1,
    projectManagedOpaquePresetResizeResultV1, projectManagedEnrollmentCorrelationV1,
    type ManagedEnrollmentCorrelationV1, type ManagedEnrollmentFullCorrelationV1, type ManagedMachineReadV1,
    type MachineSetupReportInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedOpaquePresetCustodianAdmissionV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { hydrateManagedOpaquePresetMachineV1, prepareManagedOpaquePresetAcquireV1, prepareManagedOpaquePresetReportV1,
    readManagedOpaquePresetNativeControlResultV1, type ManagedOpaquePresetContentOpenerV1 } from '@happier-dev/cli-common/machines/managed';
import { MachineProvisionerResizeResultV1Schema,
    type MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { randomBytes } from 'node:crypto';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';
import { ManagedMachineControllerError } from './controllerErrors';

/** Kept inside the existing verified-custody callback; its Account key is zeroed when that callback settles. */
export type ManagedPresetDefinitionOpener = (content: ManagedMachinePresetStoredContentCarrierV1,
    recipients?: readonly unknown[]) => ReturnType<ManagedOpaquePresetContentOpenerV1>;

type PresetContentCarrier = Readonly<{ content: unknown; recipients: readonly unknown[] }>;
export type ManagedPresetContentCarrier = Readonly<{
    machine: ManagedMachineV1;
    presetContent?: PresetContentCarrier;
}>;

type LocalPresetSnapshot = Readonly<{
    preset: NonNullable<ManagedOpaquePresetMachineV1['preset']>;
    /** Original mode-tagged carrier; never decrypted into a Home request. */
    content: ManagedMachinePresetStoredContentCarrierV1;
    recipients: readonly unknown[];
    opened: ManagedMachinePresetContentV1;
    launch: ManagedMachineFullV1['launch'];
    setup?: NonNullable<ManagedMachineFullV1['machineSetup']>['setup'];
    reviewedFacts?: ManagedMachineFullV1['reviewedFacts'];
    structural: ManagedOpaquePresetMachineV1;
}>;

const managedOpaquePresetReview = Symbol('managedOpaquePresetReview');
type ManagedOpaquePresetReview = Readonly<{
    machineId: string;
    parent: Readonly<{ actionId: string; input: unknown }>;
    custody: ManagedOpaquePresetCustodianAdmissionV1;
}>;
type ManagedOpaquePresetReviewCarrier = Readonly<{ [managedOpaquePresetReview]?: ManagedOpaquePresetReview }>;

/**
 * The opened snapshot is local evidence that lets the native executor issue
 * private reviewed children for opaque preset roles. The symbol never crosses
 * the Action/Home wire and is only attached after successful local opening.
 */
export function withManagedOpaquePresetReview<T extends object>(options: T, params: Readonly<{
    machine: ManagedMachineFullV1;
    opaqueMachine: ManagedOpaquePresetMachineV1;
    parent: Readonly<{ actionId: string; input: unknown }>;
    requestId: string;
}>): T & ManagedOpaquePresetReviewCarrier {
    const { machine, opaqueMachine, parent, requestId } = params;
    if (!machine.preset || !opaqueMachine.controller || !machine.controller
        || machine.id !== opaqueMachine.id || machine.homeId !== opaqueMachine.homeId
        || machine.custodianAccountId !== opaqueMachine.custodianAccountId
        || !samePreset(machine.preset, opaqueMachine.preset)
        || !sameStrictJsonValue(machine.controller, opaqueMachine.controller)) return options;
    if (parent.actionId === 'machines.managed.acquire') {
        const acquisition = ManagedAcquireInputV1Schema.safeParse(parent.input);
        if (!acquisition.success || !isManagedPresetAcquireInputV1(acquisition.data)
            || acquisition.data.selection.homeId !== opaqueMachine.homeId
            || acquisition.data.selection.id !== opaqueMachine.preset.id
            || acquisition.data.selection.revision !== opaqueMachine.preset.revision
            // A preset acquire may leave placement to the preset; Home's admitted row then names the controller.
            || acquisition.data.controller !== undefined
                && !sameStrictJsonValue(acquisition.data.controller, opaqueMachine.controller)) return options;
    } else {
        const input = parent.input;
        if (!input || typeof input !== 'object' || Array.isArray(input)
            || (input as Readonly<Record<string, unknown>>).homeId !== opaqueMachine.homeId
            || (input as Readonly<Record<string, unknown>>).managedId !== opaqueMachine.id) return options;
    }
    return { ...options, [managedOpaquePresetReview]: { machineId: machine.id, parent,
        custody: { homeId: opaqueMachine.homeId, custodianAccountId: opaqueMachine.custodianAccountId, requestId,
            controller: opaqueMachine.controller } } };
}

export function readManagedOpaquePresetReview(options: object, machine: ManagedMachineFullV1): ManagedOpaquePresetReview | null {
    const review = (options as ManagedOpaquePresetReviewCarrier)[managedOpaquePresetReview];
    return review?.machineId === machine.id && machine.preset ? review : null;
}

function samePreset(left: NonNullable<ManagedOpaquePresetMachineV1['preset']>, right: NonNullable<ManagedOpaquePresetMachineV1['preset']>): boolean {
    return left.id === right.id && left.revision === right.revision && left.contentEncryptionMode === right.contentEncryptionMode;
}

function accountKeySnapshot(credentials: StoredCredentials) {
    if (!credentials.encryption || credentials.accountE2eeCustody === 'historical') return null;
    try {
        const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: credentials.encryption,
            ...(credentials.encryption.type === 'dataKey' ? { dataKeyPublicKey: credentials.encryption.publicKey } : {}) });
        const accountKey = snapshot.material.type === 'legacy'
            ? deriveAccountMachineKeyFromRecoverySecret(snapshot.material.secret)
            : new Uint8Array(snapshot.material.machineKey);
        return { accountKey, fingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint) };
    } catch {
        return null;
    }
}

/**
 * The daemon's sole private projection of opaque preset rows. Server rows stay
 * structural; this cache is process-local and context is the restart delivery
 * edge. Nothing from this object is used as a controller request payload.
 */
export function createManagedPresetHydrator(input: Readonly<{
    credentials: StoredCredentials;
    serverUrl: string;
}>) {
    const snapshots = new Map<string, LocalPresetSnapshot>();

    function currentSnapshot(machine: ManagedOpaquePresetMachineV1): LocalPresetSnapshot {
        const snapshot = snapshots.get(machine.id);
        if (!snapshot || !snapshot.structural || !samePreset(snapshot.preset, machine.preset)) {
            throw new ManagedMachineControllerError('credential_unavailable');
        }
        return snapshot;
    }

    function hydrate(machine: ManagedOpaquePresetMachineV1, snapshot: LocalPresetSnapshot): ManagedMachineFullV1 {
        const full = hydrateManagedOpaquePresetMachineV1({ machine, opened: snapshot.opened });
        if (!full) throw new ManagedMachineControllerError('invalid_request');
        snapshots.set(machine.id, { ...snapshot, structural: machine });
        return full;
    }

    /**
     * Every opaque preset read shares this one Account-custody/currentness
     * boundary. Callers supply only the already server-selected carrier; they
     * never select recipients or infer the persisted author mode.
     */
    async function withVerifiedAccount<T>(mode: 'plain' | 'e2ee', signal: AbortSignal | undefined,
        read: (account: Readonly<{ accountId: string; accountKey?: Uint8Array }>) => T | Promise<T>): Promise<T> {
        const accountId = readAccountIdFromToken(input.credentials.token);
        if (!accountId) throw new ManagedMachineControllerError('credential_unavailable');
        signal?.throwIfAborted();
        if (mode === 'plain') return await read({ accountId });
        const material = accountKeySnapshot(input.credentials);
        if (!material) throw new ManagedMachineControllerError('credential_unavailable');
        try {
            const currentness = await fetchAccountEncryptionCurrentness({ token: input.credentials.token,
                credentials: input.credentials, serverBaseUrl: input.serverUrl, signal });
            if (currentness.mode !== 'e2ee' || currentness.contentKeyFingerprint !== material.fingerprint) {
                throw new ManagedMachineControllerError('credential_unavailable');
            }
            return await read({ accountId, accountKey: material.accountKey });
        } catch (error) {
            if (error instanceof ManagedMachineControllerError) throw error;
            throw new ManagedMachineControllerError('credential_unavailable');
        } finally {
            material.accountKey.fill(0);
        }
    }

    async function openContent(machine: ManagedOpaquePresetMachineV1, content: ManagedMachinePresetStoredContentCarrierV1,
        recipients: readonly unknown[], signal?: AbortSignal): Promise<ManagedMachinePresetContentV1> {
        // The persisted author mode belongs to the admitted snapshot; the
        // daemon's own current mode is only key-currentness evidence for E2EE.
        const mode = machine.preset.contentEncryptionMode;
        const opened = await withVerifiedAccount(mode, signal, account => {
            if (account.accountId !== machine.custodianAccountId) throw new ManagedMachineControllerError('credential_unavailable');
            return mode === 'plain'
                ? openManagedMachinePresetContentV1({ presetId: machine.preset.id, mode, content })
                : account.accountKey === undefined ? null : openManagedMachinePresetContentV1({ presetId: machine.preset.id, mode,
                    content, recipients, accountId: account.accountId, accountKey: account.accountKey });
        });
        if (!opened?.launch) throw new ManagedMachineControllerError('credential_unavailable');
        return opened;
    }

    /** The same custody boundary opens an exact saved revision before its first policy admission. */
    async function withPresetDefinition<T>(preset: ManagedMachinePresetV1,
        read: (opened: ManagedMachinePresetContentV1, open: ManagedPresetDefinitionOpener) => Promise<T>,
        signal?: AbortSignal): Promise<T> {
        return await withVerifiedAccount(preset.contentEncryptionMode, signal, async account => {
            const open: ManagedPresetDefinitionOpener = (content, recipients = preset.recipients) => preset.contentEncryptionMode === 'plain'
                ? openManagedMachinePresetContentV1({ presetId: preset.id, mode: 'plain', content })
                : account.accountKey === undefined ? null : openManagedMachinePresetContentV1({ presetId: preset.id,
                    mode: 'e2ee', content, recipients, accountId: account.accountId, accountKey: account.accountKey });
            const opened = await open(preset.content);
            if (!opened?.launch) throw new ManagedMachineControllerError('credential_unavailable');
            return await read(opened, open);
        });
    }

    /** Open exactly the server-selected single-recipient setup/get projection. */
    async function openRecipientProjection(params: Readonly<{
        presetId: string;
        mode: 'plain' | 'e2ee';
        projection: unknown;
        signal?: AbortSignal;
    }>): Promise<ManagedMachinePresetContentV1> {
        const opened = await withVerifiedAccount(params.mode, params.signal, account => params.mode === 'plain'
            ? openManagedMachinePresetRecipientProjectionV1({ presetId: params.presetId, mode: params.mode,
                projection: params.projection })
            : account.accountKey === undefined ? null : openManagedMachinePresetRecipientProjectionV1({ presetId: params.presetId,
                mode: params.mode, projection: params.projection, accountId: account.accountId, accountKey: account.accountKey }));
        if (!opened) throw new ManagedMachineControllerError('credential_unavailable');
        return opened;
    }

    /**
     * Hydrate a validated Account GET/LIST read locally. The response already
     * selected this Account's envelope; it must not be re-selected as a
     * custodian carrier or retained as a report-capable snapshot.
     */
    async function openRead(read: ManagedMachineReadV1, signal?: AbortSignal): Promise<ManagedMachineFullV1> {
        if (!isManagedOpaquePresetReadV1(read)) return ManagedMachineFullV1Schema.parse(read);
        const opened = await openRecipientProjection({ presetId: read.machine.preset.id,
            mode: read.machine.preset.contentEncryptionMode, projection: read.presetContent, signal });
        const full = hydrateManagedOpaquePresetMachineV1({ machine: read.machine, opened });
        if (!full) throw new ManagedMachineControllerError('credential_unavailable');
        return full;
    }

    /** Run one opaque rewrite while the existing E2EE custody boundary holds its ephemeral Account key. */
    async function withE2eeAccountKey<T>(read: (account: Readonly<{
        accountId: string;
        accountKey: Uint8Array;
    }>) => T | Promise<T>, signal?: AbortSignal): Promise<T> {
        return await withVerifiedAccount('e2ee', signal, async account => {
            if (!account.accountKey) throw new ManagedMachineControllerError('credential_unavailable');
            return await read({ accountId: account.accountId, accountKey: account.accountKey });
        });
    }

    async function openSnapshot(machine: ManagedOpaquePresetMachineV1, presetContent: PresetContentCarrier,
        signal?: AbortSignal, heldOpen?: ManagedOpaquePresetContentOpenerV1): Promise<ManagedMachinePresetContentV1> {
        const stored = ManagedMachinePresetStoredContentV1Schema.safeParse(presetContent.content);
        if (!stored.success) throw new ManagedMachineControllerError('credential_unavailable');
        const opened = heldOpen ? await heldOpen(stored.data) : await openContent(machine, stored.data, presetContent.recipients, signal);
        if (!opened?.launch) throw new ManagedMachineControllerError('credential_unavailable');
        const snapshot: LocalPresetSnapshot = { preset: machine.preset, content: stored.data, recipients: presetContent.recipients,
            opened, launch: opened.launch, ...(opened.setup ? { setup: opened.setup } : {}),
            ...(opened.reviewedFacts ? { reviewedFacts: opened.reviewedFacts } : {}), structural: machine };
        snapshots.set(machine.id, snapshot);
        return opened;
    }

    async function open(machine: ManagedOpaquePresetMachineV1, presetContent: PresetContentCarrier, signal?: AbortSignal): Promise<ManagedMachineFullV1> {
        await openSnapshot(machine, presetContent, signal);
        const snapshot = currentSnapshot(machine);
        return hydrate(machine, snapshot);
    }

    function normalize(machine: ManagedMachineV1): ManagedMachineFullV1 {
        if (!isManagedOpaquePresetMachineV1(machine)) return ManagedMachineFullV1Schema.parse(machine);
        return hydrate(machine, currentSnapshot(machine));
    }

    /**
     * The admitted opaque override and the provider-derived default are both
     * resolved after local custody opens the exact admitted content. No raw
     * launch name crosses Home or is copied into a structural row.
     */
    async function prepareAdmissionAcquire(machine: ManagedOpaquePresetMachineV1, override: unknown,
        provisioner: Pick<MachineProvisionerContributionV1, 'id' | 'title'>, signal?: AbortSignal,
        heldOpen?: ManagedPresetDefinitionOpener): Promise<ManagedMachineFullV1> {
        const snapshot = snapshots.get(machine.id);
        const structuralMachine = snapshot?.structural;
        if (!snapshot || !structuralMachine || !samePreset(snapshot.preset, machine.preset)) {
            throw new ManagedMachineControllerError('credential_unavailable');
        }
        const parsedOverride = override === undefined ? undefined : readManagedMachinePresetContentOverrideForModeV1({
            mode: machine.preset.contentEncryptionMode, override,
        });
        if (parsedOverride === null) throw new ManagedMachineControllerError('credential_unavailable');
        const openedOverride = parsedOverride === undefined ? undefined
            : heldOpen ? await heldOpen(parsedOverride.content)
                : await openContent(structuralMachine, parsedOverride.content, snapshot.recipients, signal);
        const open: ManagedOpaquePresetContentOpenerV1 = content => {
            if (sameStrictJsonValue(content, snapshot.content)) return snapshot.opened;
            if (parsedOverride && openedOverride && sameStrictJsonValue(content, parsedOverride.content)) return openedOverride;
            return null;
        };
        const prepared = await prepareManagedOpaquePresetAcquireV1({ content: snapshot.content, override: parsedOverride,
            provisioner, open });
        if (!prepared) throw new ManagedMachineControllerError('credential_unavailable');
        return hydrate(structuralMachine, { ...snapshot, content: prepared.content, opened: prepared.opened,
            launch: prepared.opened.launch, ...(prepared.opened.setup ? { setup: prepared.opened.setup } : {}),
            ...(prepared.opened.reviewedFacts ? { reviewedFacts: prepared.opened.reviewedFacts } : {}) });
    }

    /** Resolve an admitted private resize request and retain it only in the local sealed snapshot. */
    async function prepareResize(machine: ManagedMachineFullV1, override: unknown,
        signal?: AbortSignal): Promise<MachineProvisionerSizeV1> {
        if (!machine.preset) throw new ManagedMachineControllerError('credential_unavailable');
        const snapshot = snapshots.get(machine.id);
        const structuralMachine = snapshot?.structural;
        if (!snapshot || !structuralMachine || !samePreset(snapshot.preset, machine.preset)) {
            throw new ManagedMachineControllerError('credential_unavailable');
        }
        const parsedOverride = readManagedMachinePresetContentOverrideForModeV1({
            mode: machine.preset.contentEncryptionMode, override,
        });
        if (!parsedOverride) throw new ManagedMachineControllerError('credential_unavailable');
        const openedOverride = await openContent(structuralMachine, parsedOverride.content, snapshot.recipients, signal);
        const size = resolveManagedMachinePresetResizeOverrideV1({ baseContent: snapshot.opened, overrideContent: openedOverride });
        if (!size || !openedOverride.launch) throw new ManagedMachineControllerError('credential_unavailable');
        snapshots.set(machine.id, { ...snapshot, content: parsedOverride.content, opened: openedOverride,
            launch: openedOverride.launch, ...(openedOverride.setup ? { setup: openedOverride.setup } : {}),
            ...(openedOverride.reviewedFacts ? { reviewedFacts: openedOverride.reviewedFacts } : {}) });
        return size;
    }

    async function preparePresetContentReport(machine: ManagedMachineFullV1, input: Readonly<{
        reviewedFacts?: ManagedConfigurationFactsV1;
        nativeResult?: AcquireResultV1;
        observation?: ProviderObservationV1;
        nativeControlResult?: ManagedMachinePresetNativeControlResultV1;
        setupSourceFacts?: MachineSetupSourceFactsMapV1;
    }>, signal?: AbortSignal): Promise<ManagedMachinePresetStoredContentV1> {
        if (!machine.preset) throw new ManagedMachineControllerError('credential_unavailable');
        const snapshot = snapshots.get(machine.id);
        if (!snapshot || !samePreset(snapshot.preset, machine.preset)) {
            throw new ManagedMachineControllerError('credential_unavailable');
        }
        const reviewedFacts = input.reviewedFacts ?? snapshot.reviewedFacts;
        const mode = machine.preset.contentEncryptionMode;
        const prepared = await withVerifiedAccount(mode, signal, account => prepareManagedOpaquePresetReportV1({
            machine: snapshot.structural, content: snapshot.content, recipients: snapshot.recipients,
            opened: { ...snapshot.opened, launch: snapshot.launch }, accountId: account.accountId,
            ...(account.accountKey === undefined ? {} : { accountKey: account.accountKey }), randomBytes,
            ...(reviewedFacts === undefined ? {} : { reviewedFacts }),
            ...(input.nativeResult === undefined ? {} : { nativeResult: input.nativeResult }),
            ...(input.observation === undefined ? {} : { observation: input.observation }),
            ...(input.nativeControlResult === undefined ? {} : { nativeControlResult: input.nativeControlResult }),
            ...(input.setupSourceFacts === undefined ? {} : { setupSourceFacts: input.setupSourceFacts }),
        }));
        if (!prepared) throw new ManagedMachineControllerError('credential_unavailable');
        snapshots.set(machine.id, { ...snapshot, content: prepared.content, opened: prepared.opened,
            ...(reviewedFacts === undefined ? {} : { reviewedFacts }) });
        return prepared.content;
    }

    /** Retry facts use the same admitted private snapshot as provider results.
     * Never send a hydrated plaintext projection to Home. */
    async function prepareBoundSetupReport(machine: ManagedMachineFullV1,
        input: Extract<MachineSetupReportInputV1, { target: unknown }>, signal?: AbortSignal): Promise<MachineSetupReportInputV1> {
        if (machine.id !== input.managedId || machine.homeId !== input.homeId
            || machine.preset?.id !== input.presetId || machine.preset.revision !== input.presetRevision) {
            throw new ManagedMachineControllerError('intent_changed');
        }
        if ('bootstrapInstalled' in input) return input;
        const { sourceFacts, ...report } = input;
        const content = await preparePresetContentReport(machine,
            sourceFacts === undefined ? {} : { setupSourceFacts: sourceFacts }, signal);
        return { ...report, presetContent: { content } };
    }

    /**
     * One outbound choke point for opaque controller reports. Full native
     * values are sealed under the admitted content key; Home receives only
     * protocol-owned lifecycle/result projections.
     */
    async function prepareControllerReport(path: 'report' | 'report-intent', body: unknown,
        signal?: AbortSignal): Promise<unknown> {
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ManagedMachineControllerError('invalid_request');
        const value = body as Readonly<Record<string, unknown>>;
        if (typeof value.managedId !== 'string') throw new ManagedMachineControllerError('invalid_request');
        const snapshot = snapshots.get(value.managedId);
        if (!snapshot?.structural) return body;
        // Credential-delivery reports share the endpoint but have their own
        // opaque-safe contract and never carry native provider facts.
        if (value.result === undefined) return body;
        const machine = hydrate(snapshot.structural, snapshot);
        const common = {
            homeId: value.homeId,
            managedId: value.managedId,
            expectedIntentRevision: value.expectedIntentRevision,
            requestId: value.requestId,
            ...(value.controller === undefined ? {} : { controller: value.controller }),
        };
        const reviewedFacts = value.configurationFacts === undefined ? snapshot.reviewedFacts
            : (() => {
                const parsed = ManagedConfigurationFactsV1Schema.safeParse(value.configurationFacts);
                if (!parsed.success) throw new ManagedMachineControllerError('invalid_request');
                return parsed.data;
            })();
        const observation = value.observation === undefined ? undefined : (() => {
            const parsed = ProviderObservationV1Schema.safeParse(value.observation);
            if (!parsed.success) throw new ManagedMachineControllerError('invalid_request');
            return parsed.data;
        })();
        if (path === 'report') {
            const result = AcquireResultV1Schema.safeParse(value.result);
            if (!result.success) throw new ManagedMachineControllerError('invalid_request');
            const presetContent = await preparePresetContentReport(machine, {
                ...(reviewedFacts === undefined ? {} : { reviewedFacts }),
                nativeResult: result.data,
                ...(observation === undefined ? {} : { observation }),
            }, signal);
            return {
                ...common,
                result: projectManagedOpaquePresetAcquireResultV1(result.data), presetContent,
                ...(value.bootstrapInstalled === true ? { bootstrapInstalled: true as const } : {}),
                ...(observation === undefined ? {} : { observation: projectManagedOpaquePresetObservationV1(observation) }),
            };
        }
        if (!value.result || typeof value.result !== 'object' || Array.isArray(value.result)
            || typeof (value.result as Readonly<Record<string, unknown>>).kind !== 'string') {
            throw new ManagedMachineControllerError('invalid_request');
        }
        let result: ReturnType<typeof projectManagedOpaquePresetIntentResultV1>;
        try { result = projectManagedOpaquePresetIntentResultV1(value.result as Readonly<{ kind: string }>); }
        catch { throw new ManagedMachineControllerError('invalid_request'); }
        const nativeControlResult = readManagedOpaquePresetNativeControlResultV1(machine, value.result);
        if (!nativeControlResult) throw new ManagedMachineControllerError('invalid_request');
        const presetContent = await preparePresetContentReport(machine, {
            ...(reviewedFacts === undefined ? {} : { reviewedFacts }),
            ...(observation === undefined ? {} : { observation }),
            nativeControlResult,
        }, signal);
        return {
            ...common, result, presetContent,
            ...(observation === undefined ? {} : { observation: projectManagedOpaquePresetObservationV1(observation) }),
        };
    }

    /**
     * Resize has its own control wire shape, but shares the same one private
     * snapshot and structural output boundary as other native reports.
     */
    async function prepareResizeReport(body: unknown, signal?: AbortSignal): Promise<Readonly<{
        report: unknown;
        output: ReturnType<typeof ManagedResizeOutputV1Schema.parse>;
    }>> {
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ManagedMachineControllerError('invalid_request');
        const value = body as Readonly<Record<string, unknown>>;
        if (typeof value.managedId !== 'string') throw new ManagedMachineControllerError('invalid_request');
        const result = MachineProvisionerResizeResultV1Schema.safeParse(value.result);
        if (!result.success) throw new ManagedMachineControllerError('invalid_request');
        const observation = value.observation === undefined ? undefined : (() => {
            const parsed = ProviderObservationV1Schema.safeParse(value.observation);
            if (!parsed.success) throw new ManagedMachineControllerError('invalid_request');
            return parsed.data;
        })();
        const snapshot = snapshots.get(value.managedId);
        if (!snapshot?.structural) {
            return { report: body, output: ManagedResizeOutputV1Schema.parse({ result: result.data,
                ...(observation === undefined ? {} : { observation }) }) };
        }
        const machine = hydrate(snapshot.structural, snapshot);
        let structuralResult: ReturnType<typeof projectManagedOpaquePresetResizeResultV1>;
        try { structuralResult = projectManagedOpaquePresetResizeResultV1(result.data); }
        catch { throw new ManagedMachineControllerError('invalid_request'); }
        const presetContent = await preparePresetContentReport(machine, {
            nativeControlResult: { kind: 'resize', result: result.data },
            ...(observation === undefined ? {} : { observation }),
        }, signal);
        const safeObservation = observation === undefined ? undefined : projectManagedOpaquePresetObservationV1(observation);
        const output = ManagedResizeOutputV1Schema.parse({ result: structuralResult, presetContent,
            ...(safeObservation === undefined ? {} : { observation: safeObservation }) });
        return { report: { homeId: value.homeId, managedId: value.managedId, requestId: value.requestId,
            result: structuralResult, presetContent,
            ...(safeObservation === undefined ? {} : { observation: safeObservation }) }, output };
    }

    function rememberReviewedFacts(machine: ManagedMachineFullV1, reviewedFacts: NonNullable<ManagedMachineFullV1['reviewedFacts']>): void {
        const snapshot = snapshots.get(machine.id);
        if (!snapshot || !machine.preset || !samePreset(snapshot.preset, machine.preset)) return;
        const opened = ManagedMachinePresetContentV1Schema.parse({ ...snapshot.opened, launch: snapshot.launch, reviewedFacts });
        snapshots.set(machine.id, { ...snapshot, opened, reviewedFacts });
    }

    function readReviewedFacts(machine: ManagedMachineFullV1): ManagedMachineFullV1['reviewedFacts'] | undefined {
        const snapshot = snapshots.get(machine.id);
        return snapshot && machine.preset && samePreset(snapshot.preset, machine.preset) ? snapshot.reviewedFacts : undefined;
    }

    function isOpaque(machine: ManagedMachineFullV1): boolean {
        const snapshot = snapshots.get(machine.id);
        return Boolean(snapshot?.structural && machine.preset && samePreset(snapshot.preset, machine.preset));
    }

    function structural(machine: ManagedMachineFullV1): ManagedMachineV1 {
        const snapshot = snapshots.get(machine.id);
        return snapshot?.structural && machine.preset && samePreset(snapshot.preset, machine.preset) ? snapshot.structural : machine;
    }

    function projectEnrollmentCorrelation(machine: ManagedMachineFullV1,
        correlation: ManagedEnrollmentFullCorrelationV1): ManagedEnrollmentCorrelationV1 {
        return projectManagedEnrollmentCorrelationV1(structural(machine), correlation);
    }

    return { open, openSnapshot, withPresetDefinition, openRecipientProjection, openRead, withE2eeAccountKey, normalize, prepareAdmissionAcquire, prepareResize, preparePresetContentReport, prepareBoundSetupReport, prepareControllerReport, prepareResizeReport,
        rememberReviewedFacts, readReviewedFacts, isOpaque, structural, projectEnrollmentCorrelation };
}

export type ManagedPresetHydrator = ReturnType<typeof createManagedPresetHydrator>;

/** Opens an admission/context carrier only at the daemon's local custody edge. */
export async function openManagedPresetCarrier<T extends ManagedPresetContentCarrier>(carrier: T, hydrator: ManagedPresetHydrator,
    signal?: AbortSignal): Promise<Omit<T, 'machine'> & Readonly<{ machine: ManagedMachineFullV1 }>> {
    const machine = isManagedOpaquePresetMachineV1(carrier.machine)
        ? carrier.presetContent === undefined
            ? (() => { throw new ManagedMachineControllerError('credential_unavailable'); })()
            : await hydrator.open(carrier.machine, carrier.presetContent, signal)
        : ManagedMachineFullV1Schema.parse(carrier.machine);
    return { ...carrier, machine };
}
