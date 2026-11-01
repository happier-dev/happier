import { z } from 'zod/mini';
import { ActionPolicyInputSchemas, isActionPolicyActionId, readActionAudiencePolicy,
    applyActionPolicyMutation, type ActionPolicyActionId, type ActionPolicySetResult } from '@happier-dev/protocol/actions';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { SettingsDeclarationActionInputSchemasV1, SettingsDeclarationActionOutputSchemasV1, SettingsDeclarationValueV1Schema, SettingsDeclarationMutationReversalV1Schema, SettingsDeclarationCapturedMutationV1Schema, type SettingsDeclarationActionIdV1, type SettingsDeclarationDescriptorV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { AccountSettingMutationV1Schema, applyAccountSettingMutationV1 } from '@happier-dev/protocol/account/settings/accountSettingMutationV1';
import { captureSettingMutationV1, restoreSettingMutationV1 } from '@happier-dev/protocol/actions/settings/settingMutationReversal';
import { ACCOUNT_SETTING_DEFINITIONS } from '@happier-dev/protocol/account/settings/accountSettings';
import type { AutomationV3Settings } from '@happier-dev/protocol/automations/automationApiV3';
import { executeAutomationSettingDeclaration } from '@happier-dev/protocol/actions';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ActionApprovalRequestCreatedResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { getSettingsPageDeclarations } from '@/components/settings/catalog/settingsPageDeclarations';
import { buildSettingHref, readBuiltInAccountSettingUiRef, settingRendersOnHost, settingTargetKinds, SETTING_VALUE_UNAVAILABLE, type SettingRef, type SettingsHost, type SettingsMutationServices } from '@/components/settings/catalog/settingDeclarations';
import { flattenSettingsPageCatalog, SETTINGS_PAGE_CATALOG } from '@/components/settings/catalog/pageCatalog';
import type { SettingsPageGate } from '@/components/settings/catalog/types';
import { resolveSettingsPageGateUnavailableReason } from '@/components/settings/catalog/settingsPageGateAvailability';
import { t } from '@/text';
import { settingsParse, type Settings, type SettingsWriteDelta } from '@/sync/domains/settings/settings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { LOCAL_SETTING_ARTIFACTS } from '@/sync/domains/settings/registry/local/localSettingDefinitions';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { executeHomeSettingDeclaration, homeSettingDeclarationUnavailable, readHomeSettingsDeclarationOwner,
    type HomeSettingsDeclarationRead } from '@happier-dev/protocol/actions';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { executeSessionAutoFollowSetting, executeTeamSettingDeclaration } from '@happier-dev/protocol/actions';
import type { RawSettingsMutationOptions } from './actionAccountContext';
import type { OneShotAccountSettingsMutationResult } from '@/sync/engine/settings/syncSettings';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { MachineTerminalHostSettingKeySchema, MachineTerminalHostSettingChangeSchema,
    readMachineTerminalHostSetting, buildMachineTerminalHostSettingMutation } from '@happier-dev/protocol/actions/settings/machineTerminalHostSetting';
import { MachineInstallablePolicyKeySchema, MachineInstallablePolicyChangeSchema,
    readMachineInstallablePolicySetting, buildMachineInstallablePolicySettingMutation } from '@happier-dev/protocol/actions/settings/machineInstallablePolicySetting';
import { MachineOfflineAlertSettingKeySchema, MachineOfflineAlertSettingChangeSchema,
    readMachineOfflineAlertSetting, buildMachineOfflineAlertSettingMutation } from '@happier-dev/protocol/actions/settings/machineOfflineAlertSetting';
import { machineDirectConnectionStorage, readPortableAccountSettingBindingV1 } from '@happier-dev/protocol/actions/settings/accountSettingBindings';
import { BUILT_IN_SETTINGS_DECLARATIONS_V1, readBuiltInSettingDeclarationV1, resolveBuiltInAccountSettingResetValueV1, resolveSettingsDeclarationOperationApprovalPolicyV1 } from '@happier-dev/protocol/actions/settings/settingsDeclarations';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { ProjectAtmosphereSchema } from '@happier-dev/protocol/account/settings/accountSettings';
import { normalizeProjectAtmosphere, readAtmospherePresentationSetting, editAtmospherePresentationSetting } from '@/components/atmosphere/atmosphereSettings';
import { readProjectAtmosphereSetting, mutateProjectAtmosphereSetting } from '@/components/atmosphere/projectAtmosphereSettings';
import { atmospherePresentation, DEFAULT_HOME_ATMOSPHERE } from '@happier-dev/protocol/account/settings/accountSettings';
import { MachineStorageViewSettingKeySchema, MachineStorageViewSettingChangeSchema,
    readMachineStorageViewSetting, buildMachineStorageViewSettingMutation } from '@/sync/domains/settings/registry/local/machineStorageViewSetting';

type SettingsDeclarationOwner = Readonly<{
    host: SettingsHost;
    tauriDesktop: boolean;
    /** Exact Home captured by the Settings invocation, independent of focused UI state. */
    serverId?: string;
    /** Captured trusted owner scope, never a caller-supplied settings target. */
    accountScope?: AccountSettingsScope;
    readPageGate: (pageId: string) => SettingsPageGate | undefined;
    isFeatureEnabled: (featureId: FeatureId) => Promise<boolean>;
    canUseRuntimeContributions?: () => boolean;
    /** Captured Account lifetime from the invocation host. */
    isCurrent?: () => boolean;
    mutationServices?: SettingsMutationServices;
    readAccountSettings: () => Promise<Settings>;
    setClientEncryptionRequirement?: (enabled: boolean) => Promise<'updated' | 'needs_e2ee'>;
    writeAccountSettings: (delta: SettingsWriteDelta) => Promise<void>;
    mutateAccountSettings: (mutate: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown>, options?: RawSettingsMutationOptions)
        => Promise<void | OneShotAccountSettingsMutationResult<void>>;
    readAccountSettingsSnapshot?: () => Promise<Readonly<{ raw: Record<string, unknown>; version: number }>>;
    readLocalSettings: () => LocalSettings;
    writeLocalSettings: (delta: Partial<LocalSettings>) => void;
    openHumanInteraction?: (href: string, signal?: AbortSignal) => boolean | Promise<boolean>;
    automationSettings?: Readonly<{
        read(): Promise<AutomationV3Settings>;
        write(settings: AutomationV3Settings): Promise<AutomationV3Settings>;
    }>;
}>;

function refuse(errorCode: string) {
    return { ok: false as const, errorCode, error: errorCode };
}

class RejectedSettingMutation extends Error {}
type SettingsDeclarationActionResult = z.output<(typeof SettingsDeclarationActionOutputSchemasV1)[SettingsDeclarationActionIdV1]>
    | ActionPolicySetResult
    | ReturnType<typeof refuse> | ActionApprovalRequestCreatedResult;
class ConditionalSettingConflict extends Error {}

/** The declaration is the operation's safety owner; unknown operations fail closed. */
export function resolveSettingsDeclarationOperationApprovalPolicy(anchor: string, settings: Settings): ReturnType<typeof resolveSettingsDeclarationOperationApprovalPolicyV1> {
    const ref = getSettingsPageDeclarations(undefined, settings).flatMap(page => Object.values(page.settings))
        .find(candidate => candidate.anchor === anchor);
    return resolveSettingsDeclarationOperationApprovalPolicyV1(ref?.operation);
}

/** Only existing writable built-in device preferences admit a local UI interaction without an Account. */
export function isBuiltInLocalSettingMutation(actionId: string | undefined, input: unknown): boolean {
    if (actionId !== 'settings.set' && actionId !== 'settings.reset') return false;
    const parsed = SettingsDeclarationActionInputSchemasV1[actionId].safeParse(input);
    if (!parsed.success) return false;
    const declaration = readBuiltInSettingDeclarationV1(parsed.data.anchor);
    return declaration?.storage?.scope === 'local' && declaration.storage.access === 'read_write';
}

/** Storage readers recover malformed persisted values. Action writes must reject them, never save a fallback. */
function writeSchema(schema: z.core.$ZodType): z.core.$ZodType {
    return schema instanceof z.ZodMiniCatch ? writeSchema(schema._zod.def.innerType) : schema;
}

/** U4 declarations own discovery; existing preference and domain writers own every mutation. */
export function createSettingsDeclarationAction(owner: SettingsDeclarationOwner): (args: Readonly<{
    actionId: SettingsDeclarationActionIdV1 | ActionPolicyActionId;
    input: unknown;
    context?: ActionExecutorContext;
}>) => Promise<SettingsDeclarationActionResult> {
    async function descriptor(pageId: string, ref: SettingRef, context?: ActionExecutorContext,
        readHome?: () => Promise<HomeSettingsDeclarationRead>): Promise<SettingsDeclarationDescriptorV1> {
        const sensitive = ref.sensitive === true || ref.storage?.access === 'sensitive';
        const homeBinding = ref.storage?.scope === 'home' && ref.storage.kind === 'homeSettings' ? ref.storage : null;
        const homeRead = homeBinding && !sensitive && readHome ? await readHome() : null;
        const homeUnavailable = homeBinding ? !homeRead?.ok ? 'not_bound' as const
            : homeSettingDeclarationUnavailable(homeBinding.key, homeRead.projection.entries.find(entry => entry.key === homeBinding.key)) : undefined;
        const domainReadAction = ref.storage?.scope === 'home' ? homeBinding ? 'home.settings.get' : 'follow.preferences.get'
            : ref.storage?.scope === 'team' ? ref.storage.kind === 'teamIdentityConnection' ? 'teams.identity.connections.list' : 'teams.get' : null;
        const ownerSurfaceAllowed = !domainReadAction || !context?.surface
            || getActionSpec(domainReadAction).surfaces[context.surface] === true;
        const pageGate = owner.readPageGate(pageId);
        const pageUnavailableReason = pageGate ? resolveSettingsPageGateUnavailableReason(pageGate, {
            useProfiles: pageGate.requiresProfiles ? (await owner.readAccountSettings()).useProfiles : false,
            devModeEnabled: pageGate.requiresDevMode ? owner.readLocalSettings().devModeEnabled : false,
            tauriDesktop: owner.tauriDesktop,
            features: pageGate.featureId ? { [pageGate.featureId]: await owner.isFeatureEnabled(pageGate.featureId) } : {},
        }) : undefined;
        const unavailableReason = !settingRendersOnHost(ref, owner.host) ? 'unsupported_host'
            : pageUnavailableReason ? pageUnavailableReason
            : ref.featureId && !await owner.isFeatureEnabled(ref.featureId) ? 'feature_disabled'
            : ref.contribution && owner.canUseRuntimeContributions?.() !== true ? 'not_bound'
            : readBuiltInSettingDeclarationV1(ref.anchor)?.storage?.prerequisite === 'ui_account_encryption_requirement'
                && !owner.setClientEncryptionRequirement ? 'not_bound'
            : sensitive ? 'sensitive'
            : !ref.storage ? 'not_bound'
            : ref.storage.scope === 'local' && 'kind' in ref.storage && ref.storage.kind === 'atmospherePictureLibrary'
                && !owner.mutationServices?.readAtmospherePictureLibrary ? 'unsupported_host'
            : !ownerSurfaceAllowed ? 'not_bound'
            : (ref.storage.scope === 'home' || ref.storage.scope === 'team') && !owner.mutationServices?.executeSettingsOwnerAction ? 'not_bound'
            : ref.storage.scope === 'project' && !owner.mutationServices?.projectAccountRows ? 'not_bound'
            : homeUnavailable ? homeUnavailable
            : 'kind' in ref.storage && ref.storage.kind === 'automationSettings' && !owner.automationSettings ? 'not_bound'
            : ref.storage.access === 'read_only' ? 'read_only'
            : undefined;
        const readable = unavailableReason === undefined || unavailableReason === 'read_only';
        return {
            anchor: ref.anchor,
            pageId,
            title: ref.title ?? String(t(ref.titleKey)),
            ...(ref.description ? { description: ref.description } : ref.descriptionKey ? { description: String(t(ref.descriptionKey)) } : {}),
            sensitive,
            readable,
            writable: unavailableReason === undefined,
            ...(ref.storage?.scope === 'account' || ref.storage?.scope === 'local' ? { storageScope: ref.storage.scope } : {}),
            ...(settingTargetKinds(ref.storage, ref.anchor).length ? { targetKinds: [...settingTargetKinds(ref.storage, ref.anchor)], targetRequired: ref.storage?.scope === 'team' || ref.storage?.scope === 'project' } : {}),
            ...(readable && ref.storage?.allowedValues ? { allowedValues: [...ref.storage.allowedValues] } : {}),
            ...(unavailableReason ? { unavailableReason } : {}),
            ...(ref.operation && (!ref.contribution || owner.canUseRuntimeContributions?.() === true)
                && (unavailableReason === undefined || unavailableReason === 'sensitive' || unavailableReason === 'not_bound' || unavailableReason === 'read_only')
                ? { operation: { actionId: 'settings.invoke' as const, requiresHumanInteraction: ref.operation.requiresHumanInteraction,
                    ...(ref.operation.kind === 'invoke' ? { requiresApproval: ref.operation.requiresApproval !== false } : {}) } } : {}),
        };
    }

    return async ({ actionId, input, context }) => {
        throwIfAborted(context?.signal);
        const currentOwner = () => !context?.signal?.aborted && owner.isCurrent?.() !== false;
        if (isActionPolicyActionId(actionId)) {
            if (!currentOwner()) return refuse('setting_not_bound');
            if (actionId === 'actions.policy.get') {
                const requested = ActionPolicyInputSchemas[actionId].parse(input);
                const current = await owner.readAccountSettings();
                if (!currentOwner()) return refuse('setting_not_bound');
                return readActionAudiencePolicy(current.actionsSettingsV1, requested.actionId, requested.audience);
            }
            const requested = actionId === 'actions.policy.set' ? ActionPolicyInputSchemas[actionId].parse(input)
                : { ...ActionPolicyInputSchemas[actionId].parse(input), mode: 'default' as const };
            let applied: ActionPolicySetResult | undefined;
            try {
                await owner.mutateAccountSettings(raw => {
                    throwIfAborted(context?.signal);
                    if (!currentOwner()) throw new RejectedSettingMutation();
                    const mutation = applyActionPolicyMutation(normalizeActionsSettingsV1(raw.actionsSettingsV1), requested);
                    applied = mutation.result;
                    return { ...raw, actionsSettingsV1: mutation.settings };
                }, { signal: context?.signal });
            } catch (error) {
                if (error instanceof RejectedSettingMutation) return refuse('setting_not_bound');
                throw error;
            }
            return applied ?? refuse('setting_not_bound');
        }
        let homeRead: Promise<HomeSettingsDeclarationRead> | undefined;
        const readHome = () => homeRead ??= owner.mutationServices?.executeSettingsOwnerAction
            ? readHomeSettingsDeclarationOwner(owner.mutationServices.executeSettingsOwnerAction, context ?? {}, currentOwner)
            : Promise.resolve({ ok: false as const, result: refuse('setting_not_bound') });
        // Static device-local declarations do not acquire Account data or sign-in requirements.
        const localDeclaration = input && typeof input === 'object' && 'anchor' in input
            && readBuiltInSettingDeclarationV1(input.anchor)?.storage?.scope === 'local';
        const declarations = getSettingsPageDeclarations(undefined, localDeclaration ? undefined : await owner.readAccountSettings());
        if (actionId === 'settings.list') {
            const parsed = SettingsDeclarationActionInputSchemasV1[actionId].parse(input);
            const pageAnchors = new Set(declarations.flatMap(page => Object.values(page.settings).map(ref => ref.anchor)));
            const portablePreferences = BUILT_IN_SETTINGS_DECLARATIONS_V1.flatMap(declaration => {
                if (pageAnchors.has(declaration.anchor) || parsed.pageId && declaration.pageId !== parsed.pageId) return [];
                const ref = readBuiltInAccountSettingUiRef(declaration.anchor);
                return ref ? [{ pageId: declaration.pageId, ref }] : [];
            });
            const items = await Promise.all(declarations
                .filter((page) => !parsed.pageId || page.pageId === parsed.pageId)
                .flatMap((page) => Object.values(page.settings).map((ref) => descriptor(page.pageId, ref, context, readHome)))
                .concat(portablePreferences.map(({ pageId, ref }) => descriptor(pageId, ref, context, readHome))));
            const connection = readBuiltInSettingDeclarationV1('machines.connection.direct');
            if (connection && (!parsed.pageId || parsed.pageId === 'machines')) {
                items.push({ anchor: connection.anchor, pageId: connection.pageId, title: connection.title,
                    description: connection.description, readable: true, writable: true, sensitive: false,
                    storageScope: 'account', allowedValues: [...machineDirectConnectionStorage.allowedValues] });
            }
            const machineHost = readBuiltInSettingDeclarationV1('machines.terminal.host');
            if (machineHost && (!parsed.pageId || parsed.pageId === 'machines')) {
                items.push({ anchor: machineHost.anchor, pageId: machineHost.pageId, title: machineHost.title,
                    description: machineHost.description, readable: true, writable: true, sensitive: false,
                    storageScope: 'account' });
            }
            const installablePolicy = readBuiltInSettingDeclarationV1('machines.installables.policy');
            if (installablePolicy && (!parsed.pageId || parsed.pageId === 'machines')) {
                items.push({ anchor: installablePolicy.anchor, pageId: installablePolicy.pageId, title: installablePolicy.title,
                    description: installablePolicy.description, readable: true, writable: true, sensitive: false,
                    storageScope: 'account' });
            }
            const storageView = readBuiltInSettingDeclarationV1('machines.storage.view');
            if (storageView && (!parsed.pageId || parsed.pageId === 'machines')) {
                items.push({ anchor: storageView.anchor, pageId: storageView.pageId, title: storageView.title,
                    description: storageView.description, readable: true, writable: true, sensitive: false,
                    storageScope: 'local' });
            }
            return { items };
        }
        const parsed = SettingsDeclarationActionInputSchemasV1[actionId].parse(input);
        if (parsed.anchor === 'machines.storage.view') {
            if (actionId !== 'settings.get' && actionId !== 'settings.set') return refuse('setting_reset_unsupported');
            if (!currentOwner()) return refuse('setting_not_bound');
            if ('target' in parsed && parsed.target) return refuse('setting_target_mismatch');
            const key = MachineStorageViewSettingKeySchema.safeParse('key' in parsed ? parsed.key : undefined);
            if (!key.success) return refuse('setting_key_required');
            if (actionId === 'settings.get') {
                if ('includeVersion' in parsed && parsed.includeVersion) return refuse('setting_conditional_mutation_unsupported');
                return { anchor: parsed.anchor, value: readMachineStorageViewSetting(owner.readLocalSettings(), key.data) };
            }
            const requested = SettingsDeclarationActionInputSchemasV1['settings.set'].parse(input);
            const change = MachineStorageViewSettingChangeSchema.safeParse(requested.value);
            if (!change.success) return refuse('invalid_setting_value');
            if (requested.reversal || requested.expectedSettingsVersion !== undefined) return refuse('setting_conditional_mutation_unsupported');
            throwIfAborted(context?.signal);
            if (!currentOwner()) return refuse('setting_not_bound');
            owner.writeLocalSettings(buildMachineStorageViewSettingMutation(owner.readLocalSettings(), key.data, change.data));
            return { anchor: parsed.anchor, value: change.data };
        }
        if (parsed.anchor === 'notifications.machineOffline') {
            if (actionId !== 'settings.get' && actionId !== 'settings.set') return refuse('setting_reset_unsupported');
            if (!currentOwner()) return refuse('setting_not_bound');
            if ('target' in parsed && parsed.target) return refuse('setting_target_mismatch');
            const key = MachineOfflineAlertSettingKeySchema.safeParse('key' in parsed ? parsed.key : undefined);
            if (!key.success) return refuse('setting_key_required');
            if (actionId === 'settings.get') {
                const settings = await owner.readAccountSettings();
                if (!currentOwner()) return refuse('setting_not_bound');
                return { anchor: parsed.anchor, value: readMachineOfflineAlertSetting(settings, key.data) };
            }
            const requested = SettingsDeclarationActionInputSchemasV1['settings.set'].parse(input);
            const change = MachineOfflineAlertSettingChangeSchema.safeParse(requested.value);
            if (!change.success) return refuse('invalid_setting_value');
            if (requested.reversal || requested.expectedSettingsVersion !== undefined) return refuse('setting_conditional_mutation_unsupported');
            try {
                await owner.mutateAccountSettings(raw => {
                    throwIfAborted(context?.signal);
                    if (!currentOwner()) throw new RejectedSettingMutation();
                    const patch = buildMachineOfflineAlertSettingMutation(settingsParse(raw), key.data, change.data);
                    if (!patch) throw new RejectedSettingMutation();
                    return { ...raw, ...patch };
                });
            } catch (error) {
                if (error instanceof RejectedSettingMutation) return refuse('invalid_setting_value');
                throw error;
            }
            return { anchor: parsed.anchor, value: change.data };
        }
        if (parsed.anchor === 'machines.connection.direct') {
            if (actionId !== 'settings.get' && actionId !== 'settings.set') return refuse('setting_reset_unsupported');
            if (!currentOwner()) return refuse('setting_not_bound');
            if ('target' in parsed && parsed.target) return refuse('setting_target_mismatch');
            const key = machineDirectConnectionStorage.key.safeParse('key' in parsed ? parsed.key : undefined);
            if (!key.success) return refuse('setting_key_required');
            if (actionId === 'settings.get') {
                if ('includeVersion' in parsed && parsed.includeVersion) return refuse('setting_conditional_mutation_unsupported');
                const settings = await owner.readAccountSettings();
                if (!currentOwner()) return refuse('setting_not_bound');
                return { anchor: parsed.anchor, value: machineDirectConnectionStorage.read(settings, key.data) };
            }
            const requested = SettingsDeclarationActionInputSchemasV1['settings.set'].parse(input);
            if (requested.reversal || requested.expectedSettingsVersion !== undefined) return refuse('setting_conditional_mutation_unsupported');
            const change = machineDirectConnectionStorage.value.safeParse(requested.value);
            if (!change.success) return refuse('invalid_setting_value');
            try {
                await owner.mutateAccountSettings(raw => {
                    throwIfAborted(context?.signal);
                    if (!currentOwner()) throw new RejectedSettingMutation();
                    const patch = machineDirectConnectionStorage.mutate(settingsParse(raw), key.data, change.data);
                    if (!patch) throw new RejectedSettingMutation();
                    return { ...raw, ...patch };
                });
            } catch (error) {
                if (error instanceof RejectedSettingMutation) return refuse('invalid_setting_value');
                throw error;
            }
            return { anchor: parsed.anchor, value: change.data };
        }
        if (parsed.anchor === 'machines.terminal.host') {
            if (actionId !== 'settings.get' && actionId !== 'settings.set') return refuse('setting_reset_unsupported');
            const key = MachineTerminalHostSettingKeySchema.safeParse('key' in parsed ? parsed.key : undefined);
            if (!key.success) return refuse('setting_key_required');
            if (actionId === 'settings.get') {
                const settings = await owner.readAccountSettings();
                return { anchor: parsed.anchor, value: readMachineTerminalHostSetting(settings, key.data) };
            }
            const requested = SettingsDeclarationActionInputSchemasV1['settings.set'].parse(input);
            const change = MachineTerminalHostSettingChangeSchema.safeParse(requested.value);
            if (!change.success) return refuse('invalid_setting_value');
            try {
                await owner.mutateAccountSettings(raw => {
                    throwIfAborted(context?.signal);
                    if (owner.isCurrent?.() === false) throw new RejectedSettingMutation();
                    const patch = buildMachineTerminalHostSettingMutation(settingsParse(raw), key.data, change.data);
                    if (!patch) throw new RejectedSettingMutation();
                    return { ...raw, ...patch };
                });
            } catch (error) {
                if (error instanceof RejectedSettingMutation) return refuse('invalid_setting_value');
                throw error;
            }
            return { anchor: parsed.anchor, value: change.data };
        }
        if (parsed.anchor === 'machines.installables.policy') {
            if (actionId !== 'settings.get' && actionId !== 'settings.set') return refuse('setting_reset_unsupported');
            const key = MachineInstallablePolicyKeySchema.safeParse('key' in parsed ? parsed.key : undefined);
            if (!key.success) return refuse('setting_key_required');
            if (actionId === 'settings.get') {
                const settings = await owner.readAccountSettings();
                const output = SettingsDeclarationActionOutputSchemasV1['settings.get'].safeParse({
                    anchor: parsed.anchor, value: readMachineInstallablePolicySetting(settings, key.data),
                });
                return output.success ? output.data : refuse('invalid_action_output');
            }
            const requested = SettingsDeclarationActionInputSchemasV1['settings.set'].parse(input);
            const change = MachineInstallablePolicyChangeSchema.safeParse(requested.value);
            if (!change.success) return refuse('invalid_setting_value');
            try {
                await owner.mutateAccountSettings(raw => {
                    throwIfAborted(context?.signal);
                    if (owner.isCurrent?.() === false) throw new RejectedSettingMutation();
                    const patch = buildMachineInstallablePolicySettingMutation(settingsParse(raw), key.data, change.data);
                    if (!patch) throw new RejectedSettingMutation();
                    return { ...raw, ...patch };
                });
            } catch (error) {
                if (error instanceof RejectedSettingMutation) return refuse('invalid_setting_value');
                throw error;
            }
            return { anchor: parsed.anchor, value: change.data };
        }
        if ('key' in parsed && parsed.key !== undefined && !(actionId === 'settings.reset'
            && readPortableAccountSettingBindingV1(readBuiltInSettingDeclarationV1(parsed.anchor) ?? {})?.reset)) return refuse('setting_key_unsupported');
        const page = declarations.find((candidate) => Object.values(candidate.settings).some((ref) => ref.anchor === parsed.anchor));
        // A mounted compound editor is an invocation, not a searchable scalar control.
        // Its private binding is acquired only for the captured host intent after admission.
        const mountedVoiceBinding = !page && owner.mutationServices?.voiceSettingsEdit
            && readBuiltInSettingDeclarationV1(parsed.anchor)?.storage?.owner === 'voiceSettingsEditBinding'
            ? { owner: 'voiceSettingsEditBinding', storage: (await import('@/voice/settings/voiceSettingBinding')).voiceSettingsEditBinding }
            : undefined;
        const ref = page ? Object.values(page.settings).find((candidate) => candidate.anchor === parsed.anchor)
            : readBuiltInAccountSettingUiRef(parsed.anchor, mountedVoiceBinding);
        const pageId = page?.pageId ?? readBuiltInSettingDeclarationV1(parsed.anchor)?.pageId;
        if (!pageId || !ref) return refuse('setting_not_found');
        const versionedRead = actionId === 'settings.get' && SettingsDeclarationActionInputSchemasV1['settings.get'].parse(input).includeVersion === true;
        const settingWrite = actionId === 'settings.set' ? SettingsDeclarationActionInputSchemasV1['settings.set'].parse(input) : undefined;
        const resetRequest = actionId === 'settings.reset' ? SettingsDeclarationActionInputSchemasV1[actionId].parse(input) : undefined;
        const { expected: resetExpected, key: resetKey, ...resetInput } = resetRequest ?? {};
        const conditionalWrite = resetExpected !== undefined || settingWrite?.expectedSettingsVersion !== undefined || settingWrite?.reversal !== undefined;
        if ((versionedRead || conditionalWrite) && (ref.storage?.scope !== 'account'
            || !('key' in ref.storage || 'kind' in ref.storage && ref.storage.kind === 'owner'))) {
            return refuse('setting_conditional_mutation_unsupported');
        }
        const target = 'target' in parsed ? parsed.target : undefined;
        const targetKinds = settingTargetKinds(ref.storage, ref.anchor);
        if (target && (!targetKinds.includes(target.kind) || target.serverId !== (owner.serverId ?? context?.serverId))) {
            return { ...refuse('setting_target_mismatch'), details: { targetKinds } };
        }
        if (actionId !== 'settings.invoke' && (ref.storage?.scope === 'team' || ref.storage?.scope === 'project') && !target) return { ...refuse('setting_target_required'), details: { targetKinds } };
        const access = await descriptor(pageId, ref, context, readHome);
        const draft = target?.kind === 'public_profile_draft' ? owner.mutationServices?.publicProfileAtmosphereDraft : undefined;
        const isCurrent = () => !context?.signal?.aborted && owner.isCurrent?.() !== false && context?.isPluginSettingsIntentCurrent?.() !== false
            && (!ref.contribution || owner.canUseRuntimeContributions?.() === true)
            && (target?.kind !== 'public_profile_draft' || Boolean(draft && draft.serverId === target.serverId && draft.isCurrent()));
        throwIfAborted(context?.signal);
        if (!isCurrent()) return refuse('setting_not_bound');
        if (target?.kind === 'public_profile_draft' && actionId !== 'settings.invoke') {
            if (!draft) return refuse('setting_not_bound');
            if (versionedRead || conditionalWrite) return refuse('setting_conditional_mutation_unsupported');
            if (!access.readable || !ref.storage) return refuse(`setting_${access.unavailableReason ?? 'not_bound'}`);
            if (actionId === 'settings.get') return { anchor: ref.anchor,
                value: SettingsDeclarationValueV1Schema.parse(readAtmospherePresentationSetting(draft.read(), ref.anchor)) };
            if (!access.writable) return refuse('setting_read_only');
            const value = actionId === 'settings.reset'
                ? readAtmospherePresentationSetting(atmospherePresentation(DEFAULT_HOME_ATMOSPHERE), ref.anchor) : settingWrite?.value;
            if (!editAtmospherePresentationSetting(draft.read(), ref.anchor, value)) return refuse('invalid_setting_value');
            await draft.update(current => {
                if (!isCurrent()) return current;
                const next = editAtmospherePresentationSetting(current, ref.anchor, value);
                if (!next) throw new RejectedSettingMutation();
                return next;
            });
            if (!isCurrent()) return refuse('setting_not_bound');
            return { anchor: ref.anchor, value: SettingsDeclarationValueV1Schema.parse(readAtmospherePresentationSetting(draft.read(), ref.anchor)) };
        }
        if (actionId === 'settings.reset') {
            if (!access.writable || !ref.storage) return refuse(`setting_${access.unavailableReason ?? 'read_only'}`);
            if (!isCurrent()) return refuse('setting_not_bound');
            const binding = ref.storage;
            if (binding.scope === 'project') {
                actionId = 'settings.set';
                input = { ...resetInput, value: 'home' };
            } else {
                let resetValue: z.infer<typeof SettingsDeclarationValueV1Schema>;
                if (binding.scope === 'account') {
                    if ('kind' in binding && binding.kind === 'owner' && binding.resetValue !== undefined) {
                        resetValue = binding.resetValue;
                    } else {
                        // A resolved scalar declaration is authoritative even when contributed rather than built in.
                        const declaration = 'key' in binding ? {
                            sensitive: ref.sensitive === true,
                            storage: { scope: 'account' as const, key: binding.key, access: binding.access,
                                invertBoolean: binding.invertBoolean, allowedValues: binding.allowedValues },
                        } : readBuiltInSettingDeclarationV1(ref.anchor);
                        if (!declaration) return refuse('setting_reset_unsupported');
                        const reset = resolveBuiltInAccountSettingResetValueV1(declaration, resetKey);
                        if (!reset.success) return refuse('setting_reset_unsupported');
                        resetValue = reset.value;
                    }
                } else if (binding.scope === 'local' && 'key' in binding) {
                    const storedValue = LOCAL_SETTING_ARTIFACTS.defaults[binding.key];
                    const reset = SettingsDeclarationValueV1Schema.safeParse(binding.invertBoolean && typeof storedValue === 'boolean' ? !storedValue : storedValue);
                    if (!reset.success) return refuse('setting_reset_unsupported');
                    resetValue = reset.data;
                } else {
                    return refuse('setting_reset_unsupported');
                }
                // Keep the original reset admission/confirmation; only its validated mutation intent is normalized.
                actionId = 'settings.set';
                input = { ...resetInput, value: resetValue };
            }
        }
        if (actionId === 'settings.invoke') {
            if (!access.operation || !ref.operation) return refuse(`setting_${access.unavailableReason ?? 'operation_unavailable'}`);
            if (!isCurrent()) return refuse('setting_not_bound');
            if (ref.operation.kind === 'interaction') {
                const route = page?.subpage?.route ?? flattenSettingsPageCatalog(SETTINGS_PAGE_CATALOG).find((candidate) => candidate.id === pageId)?.route;
                const href = route ? buildSettingHref(route, ref) : null;
                if (!href || !owner.openHumanInteraction) return { anchor: ref.anchor, status: 'unavailable' as const, reason: 'human_interaction_unavailable' };
                throwIfAborted(context?.signal);
                const opened = await owner.openHumanInteraction(href, context?.signal);
                throwIfAborted(context?.signal);
                if (!isCurrent()) return refuse('setting_not_bound');
                return { anchor: ref.anchor, status: opened ? 'interaction_opened' as const : 'unavailable' as const,
                    ...(!opened ? { reason: 'human_interaction_unavailable' } : {}) };
            }
            const operationInput = SettingsDeclarationActionInputSchemasV1['settings.invoke'].parse(input);
            const result = await ref.operation.invoke({ signal: context?.signal, input: operationInput.input, target, isCurrent,
                accountScope: owner.accountScope,
                services: owner.mutationServices,
                isFeatureEnabled: owner.isFeatureEnabled,
                readSettings: owner.readAccountSettings,
                readLocalSettings: owner.readLocalSettings,
                writeLocalSettings: delta => {
                    throwIfAborted(context?.signal);
                    if (!isCurrent()) throw new RejectedSettingMutation();
                    owner.writeLocalSettings(delta);
                },
                mutateSettings: async (mutate) => {
                    await owner.mutateAccountSettings((raw) => {
                        throwIfAborted(context?.signal);
                        if (!isCurrent()) throw new RejectedSettingMutation();
                        const settings = settingsParse(raw);
                        const delta = mutate(settings);
                        if (!delta) throw new RejectedSettingMutation();
                        return { ...raw, ...normalizeVoiceSettingsLocalDelta(delta, settings) };
                    });
                },
            });
            return { anchor: ref.anchor, ...result };
        }
        if (ref.storage?.scope === 'home') {
            const execute = owner.mutationServices?.executeSettingsOwnerAction;
            if (!isCurrent()) return refuse('setting_not_bound');
            if (!execute) return refuse('setting_not_bound');
            if (access.unavailableReason === 'sensitive' || access.unavailableReason === 'unsupported_host'
                || access.unavailableReason === 'feature_disabled') return refuse(`setting_${access.unavailableReason}`);
            if (ref.storage.kind === 'homeSettings') {
                const read = await readHome();
                if (!read.ok) return read.result;
                if (!access.readable) return refuse(`setting_${access.unavailableReason ?? 'not_bound'}`);
                if (actionId === 'settings.set' && !access.writable) return refuse('setting_read_only');
                return executeHomeSettingDeclaration({ actionId, anchor: ref.anchor, key: ref.storage.key,
                    ...(actionId === 'settings.set' ? { value: SettingsDeclarationActionInputSchemasV1['settings.set'].parse(input).value } : {}),
                    read, execute, context: context ?? {}, isCurrent });
            }
            if (!access.readable) return refuse(`setting_${access.unavailableReason ?? 'not_bound'}`);
            if (actionId === 'settings.set' && !access.writable) return refuse('setting_read_only');
            return executeSessionAutoFollowSetting({ actionId, anchor: ref.anchor, field: ref.storage.field,
                ...(actionId === 'settings.set' ? { value: SettingsDeclarationActionInputSchemasV1['settings.set'].parse(input).value } : {}),
                execute, context: context ?? {}, isCurrent });
        }
        if (!access.readable || !ref.storage) return refuse(`setting_${access.unavailableReason ?? 'not_bound'}`);
        const binding = ref.storage;
        if (binding.scope === 'local' && 'kind' in binding && binding.kind === 'atmospherePictureLibrary') {
            if (actionId !== 'settings.get') return refuse('setting_read_only');
            const read = owner.mutationServices?.readAtmospherePictureLibrary;
            if (!read) return refuse('setting_unsupported_host');
            const value = await read(context?.signal);
            return isCurrent() ? { anchor: ref.anchor, value } : refuse('setting_not_bound');
        }
        if (binding.scope === 'project') {
            const rowsOwner = owner.mutationServices?.projectAccountRows;
            if (!rowsOwner || !target || target.kind !== 'project' || !isCurrent()) return refuse('setting_not_bound');
            if (actionId === 'settings.set' && !access.writable) return refuse('setting_read_only');
            const requested = actionId === 'settings.set' ? SettingsDeclarationActionInputSchemasV1['settings.set'].parse(input).value : undefined;
            const admitted = requested === 'home' ? { success: true as const, data: 'home' as const } : ProjectAtmosphereSchema.safeParse(requested);
            if (actionId === 'settings.set' && !admitted.success) return refuse('invalid_setting_value');
            const projectContext = { rows: rowsOwner, scope: owner.accountScope, target, signal: context?.signal, isCurrent };
            if (actionId === 'settings.get') {
                const current = await readProjectAtmosphereSetting(projectContext);
                return current ? { anchor: ref.anchor, value: current.value } : refuse('setting_not_bound');
            }
            if (!admitted.success) return refuse('invalid_setting_value');
            const atmosphere = admitted.data === 'home' ? 'home' : normalizeProjectAtmosphere(admitted.data);
            const result = await mutateProjectAtmosphereSetting({ ...projectContext,
                readHome: async () => (await owner.readAccountSettings()).homeAtmosphere,
                edit: atmosphere === 'home' ? 'home' : () => atmosphere });
            return result.status === 'updated' ? { anchor: ref.anchor, value: result.value }
                : refuse(result.status === 'unavailable' ? 'setting_not_bound' : 'project_account_mutation_conflict');
        }
        if (binding.scope === 'team') {
            const execute = owner.mutationServices?.executeSettingsOwnerAction;
            if (!execute || !isCurrent()) return refuse('setting_not_bound');
            if (!target || target.kind !== 'team' && target.kind !== 'team_identity_connection') return refuse('setting_target_required');
            if (actionId === 'settings.set' && !access.writable) return refuse('setting_read_only');
            return executeTeamSettingDeclaration({ actionId, anchor: ref.anchor, binding, target,
                ...(actionId === 'settings.set' ? { value: SettingsDeclarationActionInputSchemasV1['settings.set'].parse(input).value } : {}),
                execute, context: context ?? {}, isCurrent });
        }
        if ('kind' in binding && binding.kind === 'automationSettings') {
            const automationOwner = owner.automationSettings;
            if (!automationOwner) return refuse('setting_not_bound');
            if (actionId === 'settings.set' && !access.writable) return refuse('setting_read_only');
            return executeAutomationSettingDeclaration({ actionId, anchor: ref.anchor, field: binding.field,
                ...(actionId === 'settings.set' ? { value: SettingsDeclarationActionInputSchemasV1['settings.set'].parse(input).value } : {}),
                owner: automationOwner, signal: context?.signal, isCurrent });
        }
        if (actionId === 'settings.set') {
            if (!access.writable) return refuse('setting_read_only');
            const requested = SettingsDeclarationActionInputSchemasV1['settings.set'].parse(input);
            if (readBuiltInSettingDeclarationV1(ref.anchor)?.storage?.prerequisite === 'ui_account_encryption_requirement') {
                if (typeof requested.value !== 'boolean') return refuse('invalid_setting_value');
                if (resetExpected !== undefined || requested.reversal || requested.expectedSettingsVersion !== undefined) return refuse('setting_conditional_mutation_unsupported');
                if (!owner.setClientEncryptionRequirement || !isCurrent()) return refuse('setting_not_bound');
                throwIfAborted(context?.signal);
                const result = await owner.setClientEncryptionRequirement(requested.value);
                return result === 'needs_e2ee' ? refuse('client_encryption_requirement_needs_e2ee')
                    : { anchor: ref.anchor, value: requested.value };
            }
            if (resetExpected !== undefined || requested.reversal || requested.expectedSettingsVersion !== undefined) {
                if (binding.scope !== 'account' || (resetExpected !== undefined || requested.reversal) && !owner.accountScope) return refuse('setting_conditional_mutation_unsupported');
                const reversal = resetExpected === undefined ? requested.reversal : { kind: 'reset' as const, expected: resetExpected };
                if (reversal?.kind === 'restore' && (!owner.accountScope || reversal.scope.serverId !== owner.accountScope.serverId
                    || reversal.scope.accountId !== owner.accountScope.accountId)) return refuse('setting_reversal_scope_mismatch');
                if (binding.allowedValues && !binding.allowedValues.some(allowed => allowed === requested.value)) return refuse('invalid_setting_value');
                if (binding.invertBoolean && typeof requested.value !== 'boolean') return refuse('invalid_setting_value');
                const storedValue = binding.invertBoolean ? !requested.value : requested.value;
                const value = 'key' in binding ? ACCOUNT_SETTING_DEFINITIONS[binding.key].parseMutationValue(storedValue) : null;
                const ownerValue = 'key' in binding ? null : binding.parse(storedValue);
                if (value && !value.success || ownerValue && !ownerValue.success) return refuse('invalid_setting_value');
                const prepared = 'key' in binding ? undefined : binding.prepare
                    ? await binding.prepare(await owner.readAccountSettings(), ownerValue?.success ? ownerValue.value : storedValue,
                        owner.mutationServices ?? {}, { signal: context?.signal, isCurrent })
                    : (settings: Settings) => binding.mutate(settings, ownerValue?.success ? ownerValue.value : storedValue);
                if (!('key' in binding) && !prepared) return refuse('setting_value_unavailable');
                const mutationFor = (raw: Readonly<Record<string, unknown>>) => {
                    const settings = settingsParse(raw);
                    const delta = 'key' in binding && value?.success ? { [binding.key]: value.data } : prepared?.(settings);
                    if (!delta) throw new RejectedSettingMutation();
                    return AccountSettingMutationV1Schema.parse({ operations: Object.entries(normalizeVoiceSettingsLocalDelta(delta, settings))
                        .map(([key, value]) => resetExpected !== undefined && 'key' in binding && binding.key === key
                            ? { op: 'reset', key } : { op: 'set', key, value }) });
                };
                let projected: unknown;
                let result: void | OneShotAccountSettingsMutationResult<void>;
                try {
                    result = await owner.mutateAccountSettings(raw => {
                        throwIfAborted(context?.signal);
                        if (!isCurrent()) throw new RejectedSettingMutation();
                        const mutation = mutationFor(raw);
                        const restore = reversal?.kind === 'restore' || reversal?.kind === 'reset'
                            ? restoreSettingMutationV1(raw, mutation, reversal, currentRaw => {
                                const settings = settingsParse(currentRaw);
                                return 'key' in binding
                                    ? binding.invertBoolean ? !settings[binding.key] : settings[binding.key]
                                    : binding.read(settings);
                            })
                            : undefined;
                        if (restore?.status === 'conflict') throw new ConditionalSettingConflict();
                        if (restore?.status === 'invalid') throw new RejectedSettingMutation();
                        const next = applyAccountSettingMutationV1(raw, restore?.status === 'prepared' ? restore.mutation : mutation);
                        if (next.status === 'invalid') throw new RejectedSettingMutation();
                        const settings = settingsParse(next.raw);
                        projected = 'key' in binding ? binding.invertBoolean ? !settings[binding.key] : settings[binding.key] : binding.read(settings);
                        return { ...next.raw };
                    }, { observeOutcome: true, signal: context?.signal,
                        ...(requested.expectedSettingsVersion === undefined ? {} : { expectedSettingsVersion: requested.expectedSettingsVersion, rebaseOnConflict: false }),
                        ...(reversal?.kind === 'capture' ? { capture: transition => {
                            const captured = captureSettingMutationV1(transition.before, mutationFor(transition.before), transition.applied);
                            if (!captured) throw new RejectedSettingMutation();
                            return { beforeVersion: transition.beforeVersion, ...captured };
                        } } : {}) });
                } catch (error) {
                    if (error instanceof ConditionalSettingConflict) return refuse('account_settings_mutation_conflict');
                    if (error instanceof RejectedSettingMutation) return refuse('invalid_setting_value');
                    throw error;
                }
                if (!result) return refuse('setting_conditional_mutation_unsupported');
                if (result.status === 'invalid') return refuse('account_settings_mutation_invalid');
                if (result.status !== 'applied') return refuse(`account_settings_mutation_${result.status === 'conflict' ? 'conflict' : 'outcome_unknown'}`);
                const response = { anchor: ref.anchor, ...(projected === undefined ? { unset: true as const } : { value: SettingsDeclarationValueV1Schema.parse(projected) }),
                    settingsVersion: result.settingsVersion };
                if (resetExpected !== undefined) {
                    const { settingsVersion: _settingsVersion, ...resetResponse } = response;
                    return resetResponse;
                }
                if (reversal?.kind !== 'capture') return response;
                const captured = SettingsDeclarationCapturedMutationV1Schema.safeParse(result.captured);
                if (captured.success && result.settingsVersion === captured.data.beforeVersion) {
                    const unchanged = 'changes' in captured.data ? captured.data.changes.every(change => sameStrictJsonValue(change.before, change.applied))
                        : sameStrictJsonValue(captured.data.before, captured.data.applied);
                    if (unchanged) return { ...response, reversalUnavailableReason: 'no_change' as const };
                }
                const receipt = SettingsDeclarationMutationReversalV1Schema.safeParse({
                    ...(captured.success ? captured.data : {}), scope: owner.accountScope, appliedVersion: result.settingsVersion,
                });
                return receipt.success ? { ...response, reversal: receipt.data } : response;
            }
            // Scalar choice descriptors remain useful even when a local domain owner also
            // accepts a strict compound intent (for example theme mode plus profile selection).
            const structuredLocalIntent = 'kind' in binding && binding.kind === 'localOwner'
                && requested.value !== null && typeof requested.value === 'object';
            if (binding.allowedValues && !structuredLocalIntent && !binding.allowedValues.some(allowed => allowed === requested.value)) return refuse('invalid_setting_value');
            if (binding.invertBoolean && typeof requested.value !== 'boolean') return refuse('invalid_setting_value');
            const storedValue = binding.invertBoolean ? !requested.value : requested.value;
            if (!('key' in binding)) {
                const parsedValue = binding.parse(storedValue);
                if (!parsedValue.success) return refuse('invalid_setting_value');
                if (binding.kind === 'localOwner') {
                    throwIfAborted(context?.signal);
                    if (!isCurrent()) return refuse('setting_not_bound');
                    if (binding.read(owner.readLocalSettings()) === SETTING_VALUE_UNAVAILABLE) return refuse('setting_value_unavailable');
                    const committed = await binding.commit(owner.readLocalSettings(), parsedValue.value, owner.writeLocalSettings, {
                        signal: context?.signal, isCurrent, readLocalSettings: owner.readLocalSettings,
                    });
                    throwIfAborted(context?.signal);
                    if (!isCurrent()) return refuse('setting_not_bound');
                    if (committed === SETTING_VALUE_UNAVAILABLE) return refuse('setting_value_unavailable');
                    return { anchor: ref.anchor, value: parsedValue.value };
                }
                const mutate = binding.prepare
                    ? await binding.prepare(await owner.readAccountSettings(), parsedValue.value, owner.mutationServices ?? {}, { signal: context?.signal, isCurrent })
                    : (settings: Settings) => binding.mutate(settings, parsedValue.value);
                throwIfAborted(context?.signal);
                if (!mutate) return refuse('setting_value_unavailable');
                try {
                    await owner.mutateAccountSettings((raw) => {
                        throwIfAborted(context?.signal);
                        const settings = settingsParse(raw);
                        const delta = mutate(settings);
                        if (!delta) throw new RejectedSettingMutation();
                        return { ...raw, ...normalizeVoiceSettingsLocalDelta(delta, settings) };
                    });
                } catch (error) {
                    if (error instanceof RejectedSettingMutation) return refuse('invalid_setting_value');
                    throw error;
                }
                return { anchor: ref.anchor, value: parsedValue.value };
            }
            const value = binding.scope === 'account'
                ? ACCOUNT_SETTING_DEFINITIONS[binding.key].parseMutationValue(storedValue)
                : z.safeParse(writeSchema(LOCAL_SETTING_ARTIFACTS.shape[binding.key]), storedValue);
            if (!value.success) return refuse('invalid_setting_value');
            const scalarValue = SettingsDeclarationValueV1Schema.parse(value.data);
            if (binding.scope === 'account') {
                // The key and scalar value were admitted by the typed declaration and its exact canonical schema.
                await owner.writeAccountSettings({ [binding.key]: scalarValue } as SettingsWriteDelta);
            } else {
                owner.writeLocalSettings({ [binding.key]: scalarValue } as Partial<LocalSettings>);
            }
            return { anchor: ref.anchor, value: binding.invertBoolean ? !scalarValue : scalarValue };
        }
        if (versionedRead && binding.scope === 'account' && ('key' in binding || binding.kind === 'owner')) {
            // One server revision cannot represent the answering client's independent local minimum.
            if (readBuiltInSettingDeclarationV1(ref.anchor)?.storage?.prerequisite === 'ui_account_encryption_requirement') return refuse('setting_conditional_mutation_unsupported');
            if (!owner.readAccountSettingsSnapshot) return refuse('setting_conditional_mutation_unsupported');
            const snapshot = await owner.readAccountSettingsSnapshot();
            if (!isCurrent()) return refuse('setting_not_bound');
            const settings = settingsParse(snapshot.raw);
            const value = 'key' in binding ? settings[binding.key] : binding.read(settings);
            if (value === SETTING_VALUE_UNAVAILABLE) return refuse('setting_value_unavailable');
            const output = SettingsDeclarationActionOutputSchemasV1['settings.get'].safeParse(value === undefined
                ? { anchor: ref.anchor, unset: true, settingsVersion: snapshot.version }
                : { anchor: ref.anchor, value: binding.invertBoolean ? !value : value, settingsVersion: snapshot.version });
            return output.success ? output.data : refuse('invalid_action_output');
        }
        const current = !('key' in binding)
            ? binding.kind === 'localOwner' ? binding.read(owner.readLocalSettings()) : binding.read(await owner.readAccountSettings())
            : binding.scope === 'account'
            ? (await owner.readAccountSettings())[binding.key]
            : owner.readLocalSettings()[binding.key];
        if (current === undefined) return { anchor: ref.anchor, unset: true as const };
        const value = SettingsDeclarationValueV1Schema.safeParse(binding.invertBoolean ? !current : current);
        return value.success ? { anchor: ref.anchor, value: value.data } : refuse('setting_value_unavailable');
    };
}
