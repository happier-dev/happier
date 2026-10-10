import { z } from 'zod';
import { SettingsDeclarationActionInputSchemasV1, SettingsDeclarationActionOutputSchemasV1, SettingsDeclarationValueV1Schema, SettingsDeclarationMutationReversalV1Schema, type SettingsDeclarationActionIdV1, type SettingsDeclarationDescriptorV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { ACCOUNT_SETTING_DEFINITIONS } from '@happier-dev/protocol/account/settings/accountSettings';
import type { AutomationV3Settings } from '@happier-dev/protocol/automations/automationApiV3';
import { executeAutomationSettingDeclaration } from '@happier-dev/protocol/actions';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { isAccountSettingActionSurfaceAllowedV1 } from '@happier-dev/protocol/actions/accountSettingDeclarations';

import { getSettingsPageDeclarations } from '@/components/settings/catalog/settingsPageDeclarations';
import { buildSettingHref, settingRendersOnHost, settingTargetKinds, type SettingRef, type SettingsHost, type SettingsMutationServices } from '@/components/settings/catalog/settingDeclarations';
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
import { readRawSettingScalarV1 } from '@happier-dev/protocol/actions';
import type { RawSettingsMutationOptions } from './actionAccountContext';
import type { OneShotAccountSettingsMutationResult } from '@/sync/engine/settings/syncSettings';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';

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
    | ReturnType<typeof refuse>;
class ConditionalSettingConflict extends Error {}
const CapturedSettingMutationSchema = z.object({
    beforeVersion: SettingsDeclarationMutationReversalV1Schema.shape.beforeVersion,
    before: SettingsDeclarationMutationReversalV1Schema.shape.before,
    applied: SettingsDeclarationMutationReversalV1Schema.shape.applied,
}).strict();

function rawScalar(raw: Readonly<Record<string, unknown>>, key: string) {
    const value = readRawSettingScalarV1(raw, key);
    if (!value) throw new RejectedSettingMutation();
    return value;
}

/** The declaration is the operation's safety owner; unknown operations fail closed. */
export function resolveSettingsDeclarationOperationApprovalRequired(anchor: string, settings: Settings): boolean {
    const ref = getSettingsPageDeclarations(undefined, settings).flatMap(page => Object.values(page.settings))
        .find(candidate => candidate.anchor === anchor);
    return ref?.operation?.kind !== 'invoke' || ref.operation.requiresApproval !== false;
}

/** Storage readers recover malformed persisted values. Action writes must reject them, never save a fallback. */
function writeSchema(schema: z.core.$ZodType): z.core.$ZodType {
    return schema instanceof z.ZodCatch ? writeSchema(schema.removeCatch()) : schema;
}

/** U4 declarations own discovery; existing preference and domain writers own every mutation. */
export function createSettingsDeclarationAction(owner: SettingsDeclarationOwner): (args: Readonly<{
    actionId: SettingsDeclarationActionIdV1;
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
        const domainReadAction = ref.storage?.scope === 'home' ? homeBinding ? 'home.settings.get' : 'session.follow.preferences.get'
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
            : sensitive ? 'sensitive'
            : !ref.storage ? 'not_bound'
            : !ownerSurfaceAllowed ? 'not_bound'
            : (ref.storage.scope === 'home' || ref.storage.scope === 'team') && !owner.mutationServices?.executeSettingsOwnerAction ? 'not_bound'
            : homeUnavailable ? homeUnavailable
            : 'kind' in ref.storage && ref.storage.kind === 'automationSettings' && !owner.automationSettings ? 'not_bound'
            : ref.storage.access === 'read_only' ? 'read_only'
            : undefined;
        const readable = unavailableReason === undefined || unavailableReason === 'read_only';
        const surfaceAllowsMutation = isAccountSettingActionSurfaceAllowedV1('settings.set', { anchor: ref.anchor }, context?.surface);
        return {
            anchor: ref.anchor,
            pageId,
            title: ref.title ?? String(t(ref.titleKey)),
            ...(ref.description ? { description: ref.description } : ref.descriptionKey ? { description: String(t(ref.descriptionKey)) } : {}),
            sensitive,
            readable,
            writable: unavailableReason === undefined && surfaceAllowsMutation,
            ...(ref.storage?.scope === 'account' || ref.storage?.scope === 'local' ? { storageScope: ref.storage.scope } : {}),
            ...(settingTargetKinds(ref.storage).length ? { targetKinds: [...settingTargetKinds(ref.storage)], targetRequired: ref.storage?.scope === 'team' } : {}),
            ...(readable && ref.storage?.allowedValues ? { allowedValues: [...ref.storage.allowedValues] } : {}),
            ...(unavailableReason ? { unavailableReason } : {}),
            ...(surfaceAllowsMutation && ref.operation && (!ref.contribution || owner.canUseRuntimeContributions?.() === true)
                && (unavailableReason === undefined || unavailableReason === 'sensitive' || unavailableReason === 'not_bound' || unavailableReason === 'read_only')
                ? { operation: { actionId: 'settings.invoke' as const, requiresHumanInteraction: ref.operation.requiresHumanInteraction,
                    ...(ref.operation.kind === 'invoke' ? { requiresApproval: ref.operation.requiresApproval !== false } : {}) } } : {}),
        };
    }

    return async ({ actionId, input, context }: Readonly<{ actionId: SettingsDeclarationActionIdV1; input: unknown; context?: ActionExecutorContext }>) => {
        throwIfAborted(context?.signal);
        const currentOwner = () => !context?.signal?.aborted && owner.isCurrent?.() !== false;
        let homeRead: Promise<HomeSettingsDeclarationRead> | undefined;
        const readHome = () => homeRead ??= owner.mutationServices?.executeSettingsOwnerAction
            ? readHomeSettingsDeclarationOwner(owner.mutationServices.executeSettingsOwnerAction, context ?? {}, currentOwner)
            : Promise.resolve({ ok: false as const, result: refuse('setting_not_bound') });
        const declarations = getSettingsPageDeclarations(undefined, await owner.readAccountSettings());
        if (actionId === 'settings.list') {
            const parsed = SettingsDeclarationActionInputSchemasV1[actionId].parse(input);
            const items = await Promise.all(declarations
                .filter((page) => !parsed.pageId || page.pageId === parsed.pageId)
                .flatMap((page) => Object.values(page.settings).map((ref) => descriptor(page.pageId, ref, context, readHome))));
            return { items };
        }
        const parsed = SettingsDeclarationActionInputSchemasV1[actionId].parse(input);
        const page = declarations.find((candidate) => Object.values(candidate.settings).some((ref) => ref.anchor === parsed.anchor));
        const ref = page && Object.values(page.settings).find((candidate) => candidate.anchor === parsed.anchor);
        if (!page || !ref) return refuse('setting_not_found');
        const versionedRead = actionId === 'settings.get' && SettingsDeclarationActionInputSchemasV1['settings.get'].parse(input).includeVersion === true;
        const settingWrite = actionId === 'settings.set' ? SettingsDeclarationActionInputSchemasV1['settings.set'].parse(input) : undefined;
        const conditionalWrite = settingWrite?.expectedSettingsVersion !== undefined || settingWrite?.reversal !== undefined;
        if ((versionedRead || conditionalWrite) && (ref.storage?.scope !== 'account' || !('key' in ref.storage))) {
            return refuse('setting_conditional_mutation_unsupported');
        }
        const target = 'target' in parsed ? parsed.target : undefined;
        const targetKinds = settingTargetKinds(ref.storage);
        if (target && (!targetKinds.includes(target.kind) || target.serverId !== (owner.serverId ?? context?.serverId))) {
            return { ...refuse('setting_target_mismatch'), details: { targetKinds } };
        }
        if (actionId !== 'settings.invoke' && ref.storage?.scope === 'team' && !target) return { ...refuse('setting_target_required'), details: { targetKinds } };
        const access = await descriptor(page.pageId, ref, context, readHome);
        const isCurrent = () => !context?.signal?.aborted && owner.isCurrent?.() !== false && (!ref.contribution || owner.canUseRuntimeContributions?.() === true);
        throwIfAborted(context?.signal);
        if (actionId === 'settings.reset') {
            if (!access.writable || !ref.storage) return refuse(`setting_${access.unavailableReason ?? 'read_only'}`);
            const binding = ref.storage;
            if (!('key' in binding) || (binding.scope !== 'account' && binding.scope !== 'local')) {
                return refuse('setting_reset_unsupported');
            }
            const storedValue = binding.scope === 'account'
                ? ACCOUNT_SETTING_DEFINITIONS[binding.key].default
                : LOCAL_SETTING_ARTIFACTS.defaults[binding.key];
            if (binding.scope === 'account') {
                await owner.writeAccountSettings({ [binding.key]: storedValue } as SettingsWriteDelta);
            } else {
                owner.writeLocalSettings({ [binding.key]: storedValue } as Partial<LocalSettings>);
            }
            const value = SettingsDeclarationValueV1Schema.safeParse(binding.invertBoolean && typeof storedValue === 'boolean' ? !storedValue : storedValue);
            return value.success ? { anchor: ref.anchor, value: value.data } : refuse('setting_value_unavailable');
        }
        if (actionId === 'settings.invoke') {
            if (!access.operation || !ref.operation) return refuse(`setting_${access.unavailableReason ?? 'operation_unavailable'}`);
            if (!isCurrent()) return refuse('setting_not_bound');
            if (ref.operation.kind === 'interaction') {
                const route = page.subpage?.route ?? flattenSettingsPageCatalog(SETTINGS_PAGE_CATALOG).find((candidate) => candidate.id === page.pageId)?.route;
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
            const result = await ref.operation.invoke({ signal: context?.signal, input: operationInput.input, isCurrent,
                services: owner.mutationServices,
                readSettings: owner.readAccountSettings,
                mutateSettings: async (mutate) => owner.mutateAccountSettings((raw) => {
                    throwIfAborted(context?.signal);
                    if (!isCurrent()) throw new RejectedSettingMutation();
                    const settings = settingsParse(raw);
                    const delta = mutate(settings);
                    if (!delta) throw new RejectedSettingMutation();
                    return { ...raw, ...normalizeVoiceSettingsLocalDelta(delta, settings) };
                }),
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
        if (binding.scope === 'team') {
            const execute = owner.mutationServices?.executeSettingsOwnerAction;
            if (!execute || !isCurrent()) return refuse('setting_not_bound');
            if (!target || target.kind === 'home') return refuse('setting_target_required');
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
            if (requested.reversal?.kind === 'restore') {
                if (!owner.accountScope || requested.reversal.scope.serverId !== owner.accountScope.serverId
                    || requested.reversal.scope.accountId !== owner.accountScope.accountId) return refuse('setting_reversal_scope_mismatch');
                if (binding.scope !== 'account' || !('key' in binding)) return refuse('setting_conditional_mutation_unsupported');
                const key = binding.key;
                const { before, applied, appliedVersion } = requested.reversal;
                if ([before, applied].some(state => 'value' in state && !ACCOUNT_SETTING_DEFINITIONS[key].parseMutationValue(state.value).success)) return refuse('invalid_setting_value');
                let result: void | OneShotAccountSettingsMutationResult<void>;
                try {
                    result = await owner.mutateAccountSettings(raw => {
                        throwIfAborted(context?.signal);
                        if (!isCurrent()) throw new RejectedSettingMutation();
                        let current: ReturnType<typeof rawScalar>;
                        try { current = rawScalar(raw, key); } catch { throw new ConditionalSettingConflict(); }
                        if (!sameStrictJsonValue(current, applied)) throw new ConditionalSettingConflict();
                        const next = { ...raw };
                        if ('unset' in before) delete next[key]; else next[key] = before.value;
                        return next;
                    }, { expectedSettingsVersion: appliedVersion, rebaseOnConflict: false, observeOutcome: true, signal: context?.signal });
                } catch (error) {
                    if (error instanceof ConditionalSettingConflict) return refuse('account_settings_mutation_conflict');
                    if (error instanceof RejectedSettingMutation) return refuse('setting_not_bound');
                    throw error;
                }
                if (!result) return refuse('setting_conditional_mutation_unsupported');
                if (result.status !== 'applied') return refuse(`account_settings_mutation_${result.status === 'conflict' ? 'conflict' : 'outcome_unknown'}`);
                const restored = settingsParse('unset' in before ? {} : { [key]: before.value })[key];
                if (restored === undefined) return { anchor: ref.anchor, unset: true as const };
                return { anchor: ref.anchor, value: binding.invertBoolean ? !restored : restored };
            }
            if (binding.allowedValues && !binding.allowedValues.some(allowed => allowed === requested.value)) return refuse('invalid_setting_value');
            if (binding.invertBoolean && typeof requested.value !== 'boolean') return refuse('invalid_setting_value');
            const storedValue = binding.invertBoolean ? !requested.value : requested.value;
            if (!('key' in binding)) {
                const parsedValue = binding.parse(storedValue);
                if (!parsedValue.success) return refuse('invalid_setting_value');
                if (binding.kind === 'localOwner') {
                    throwIfAborted(context?.signal);
                    await binding.commit(owner.readLocalSettings(), parsedValue.value, owner.writeLocalSettings);
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
                if (requested.reversal || requested.expectedSettingsVersion !== undefined) {
                    const key = binding.key;
                    if (requested.reversal && (!owner.accountScope || (scalarValue !== null && typeof scalarValue === 'object'))) return refuse('setting_conditional_mutation_unsupported');
                    let result: void | OneShotAccountSettingsMutationResult<void>;
                    try {
                        result = await owner.mutateAccountSettings(raw => {
                            throwIfAborted(context?.signal);
                            if (!isCurrent()) throw new RejectedSettingMutation();
                            return { ...raw, [key]: scalarValue };
                        }, { signal: context?.signal, observeOutcome: true,
                            ...(requested.expectedSettingsVersion === undefined ? {} : { expectedSettingsVersion: requested.expectedSettingsVersion, rebaseOnConflict: false }),
                            ...(requested.reversal ? { capture: transition => {
                                const before = rawScalar(transition.before, key);
                                if ('value' in before && !ACCOUNT_SETTING_DEFINITIONS[key].parseMutationValue(before.value).success) throw new RejectedSettingMutation();
                                return { beforeVersion: transition.beforeVersion, before, applied: rawScalar(transition.applied, key) };
                            } } : {}) });
                    } catch (error) { if (error instanceof RejectedSettingMutation) return refuse('invalid_setting_value'); throw error; }
                    if (!result) return refuse('setting_conditional_mutation_unsupported');
                    if (result.status !== 'applied') return refuse(`account_settings_mutation_${result.status === 'conflict' ? 'conflict' : 'outcome_unknown'}`);
                    const response = { anchor: ref.anchor, value: binding.invertBoolean ? !scalarValue : scalarValue,
                        ...(requested.expectedSettingsVersion === undefined ? {} : { settingsVersion: result.settingsVersion }) };
                    if (!requested.reversal) return response;
                    const captured = CapturedSettingMutationSchema.safeParse(result.captured);
                    // Only the real owner's unchanged version and exact raw equality
                    // establish no effect. A missing/malformed receipt proves neither.
                    if (captured.success && result.settingsVersion === captured.data.beforeVersion
                        && sameStrictJsonValue(captured.data.before, captured.data.applied)) {
                        return { ...response, reversalUnavailableReason: 'no_change' as const };
                    }
                    const reversal = SettingsDeclarationMutationReversalV1Schema.safeParse({
                        ...(typeof result.captured === 'object' && result.captured !== null ? result.captured : {}),
                        scope: owner.accountScope, appliedVersion: result.settingsVersion,
                    });
                    // An invalid capture never becomes an invented Undo or no-change claim.
                    if (!reversal.success) return response;
                    return { ...response, reversal: reversal.data };
                }
                // The key and scalar value were admitted by the typed declaration and its exact canonical schema.
                await owner.writeAccountSettings({ [binding.key]: scalarValue } as SettingsWriteDelta);
            } else {
                owner.writeLocalSettings({ [binding.key]: scalarValue } as Partial<LocalSettings>);
            }
            return { anchor: ref.anchor, value: binding.invertBoolean ? !scalarValue : scalarValue };
        }
        if (versionedRead && binding.scope === 'account' && 'key' in binding) {
            if (!owner.readAccountSettingsSnapshot) return refuse('setting_conditional_mutation_unsupported');
            const snapshot = await owner.readAccountSettingsSnapshot();
            if (!isCurrent()) return refuse('setting_not_bound');
            const value = settingsParse(snapshot.raw)[binding.key];
            if (value === undefined) return { anchor: ref.anchor, unset: true as const, settingsVersion: snapshot.version };
            return { anchor: ref.anchor, value: binding.invertBoolean ? !value : value, settingsVersion: snapshot.version };
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
