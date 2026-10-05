import { z } from 'zod';
import {
    SettingsDeclarationActionInputSchemasV1,
    SettingsDeclarationValueV1Schema,
    ACCOUNT_SETTING_DEFINITIONS,
    AutomationV3SettingsSchema,
    type AutomationV3Settings,
    type FeatureId,
    type SettingsDeclarationActionIdV1,
    type SettingsDeclarationDescriptorV1,
    type ActionExecutorContext,
} from '@happier-dev/protocol';

import { getSettingsPageDeclarations } from '@/components/settings/catalog/settingsPageDeclarations';
import { buildSettingHref, settingRendersOnHost, type SettingRef, type SettingsHost, type SettingsMutationServices } from '@/components/settings/catalog/settingDeclarations';
import { flattenSettingsPageCatalog, SETTINGS_PAGE_CATALOG } from '@/components/settings/catalog/pageCatalog';
import type { SettingsPageGate } from '@/components/settings/catalog/types';
import { resolveSettingsPageGateUnavailableReason } from '@/components/settings/catalog/settingsPageGateAvailability';
import { t } from '@/text';
import { settingsParse, type Settings, type SettingsWriteDelta } from '@/sync/domains/settings/settings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { LOCAL_SETTING_ARTIFACTS } from '@/sync/domains/settings/registry/local/localSettingDefinitions';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

type SettingsDeclarationOwner = Readonly<{
    host: SettingsHost;
    tauriDesktop: boolean;
    readPageGate: (pageId: string) => SettingsPageGate | undefined;
    isFeatureEnabled: (featureId: FeatureId) => Promise<boolean>;
    canUseRuntimeContributions?: () => boolean;
    /** Captured Account lifetime from the invocation host. */
    isCurrent?: () => boolean;
    mutationServices?: SettingsMutationServices;
    readAccountSettings: () => Promise<Settings>;
    writeAccountSettings: (delta: SettingsWriteDelta) => Promise<void>;
    mutateAccountSettings: (mutate: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown>) => Promise<void>;
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
export function createSettingsDeclarationAction(owner: SettingsDeclarationOwner) {
    async function descriptor(pageId: string, ref: SettingRef): Promise<SettingsDeclarationDescriptorV1> {
        const sensitive = ref.sensitive === true || ref.storage?.access === 'sensitive';
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
            ...(ref.storage ? { storageScope: ref.storage.scope } : {}),
            ...(readable && ref.storage?.allowedValues ? { allowedValues: [...ref.storage.allowedValues] } : {}),
            ...(unavailableReason ? { unavailableReason } : {}),
            ...(ref.operation && (!ref.contribution || owner.canUseRuntimeContributions?.() === true)
                && (unavailableReason === undefined || unavailableReason === 'sensitive' || unavailableReason === 'not_bound' || unavailableReason === 'read_only')
                ? { operation: { actionId: 'settings.invoke' as const, requiresHumanInteraction: ref.operation.requiresHumanInteraction,
                    ...(ref.operation.kind === 'invoke' ? { requiresApproval: ref.operation.requiresApproval !== false } : {}) } } : {}),
        };
    }

    return async ({ actionId, input, context }: Readonly<{ actionId: SettingsDeclarationActionIdV1; input: unknown; context?: ActionExecutorContext }>) => {
        throwIfAborted(context?.signal);
        const declarations = getSettingsPageDeclarations(undefined, await owner.readAccountSettings());
        if (actionId === 'settings.list') {
            const parsed = SettingsDeclarationActionInputSchemasV1[actionId].parse(input);
            const items = await Promise.all(declarations
                .filter((page) => !parsed.pageId || page.pageId === parsed.pageId)
                .flatMap((page) => Object.values(page.settings).map((ref) => descriptor(page.pageId, ref))));
            return { items };
        }
        const parsed = SettingsDeclarationActionInputSchemasV1[actionId].parse(input);
        const page = declarations.find((candidate) => Object.values(candidate.settings).some((ref) => ref.anchor === parsed.anchor));
        const ref = page && Object.values(page.settings).find((candidate) => candidate.anchor === parsed.anchor);
        if (!page || !ref) return refuse('setting_not_found');
        const access = await descriptor(page.pageId, ref);
        const isCurrent = () => !context?.signal?.aborted && owner.isCurrent?.() !== false && (!ref.contribution || owner.canUseRuntimeContributions?.() === true);
        throwIfAborted(context?.signal);
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
        if (!access.readable || !ref.storage) return refuse(`setting_${access.unavailableReason ?? 'not_bound'}`);
        const binding = ref.storage;
        if ('kind' in binding && binding.kind === 'automationSettings') {
            const automationOwner = owner.automationSettings;
            if (!automationOwner) return refuse('setting_not_bound');
            if (actionId === 'settings.set') {
                if (!access.writable) return refuse('setting_read_only');
                const requested = SettingsDeclarationActionInputSchemasV1['settings.set'].parse(input);
                const value = AutomationV3SettingsSchema.shape[binding.field].safeParse(requested.value);
                if (!value.success) return refuse('invalid_setting_value');
                const current = await automationOwner.read();
                throwIfAborted(context?.signal);
                const next = AutomationV3SettingsSchema.parse({ ...current, [binding.field]: value.data });
                const updated = await automationOwner.write(next);
                throwIfAborted(context?.signal);
                return { anchor: ref.anchor, value: updated[binding.field] };
            }
            const current = await automationOwner.read();
            throwIfAborted(context?.signal);
            return { anchor: ref.anchor, value: current[binding.field] };
        }
        if (actionId === 'settings.set') {
            if (!access.writable) return refuse('setting_read_only');
            const requested = SettingsDeclarationActionInputSchemasV1['settings.set'].parse(input);
            if (binding.allowedValues && !binding.allowedValues.includes(requested.value)) return refuse('invalid_setting_value');
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
                // The key and scalar value were admitted by the typed declaration and its exact canonical schema.
                await owner.writeAccountSettings({ [binding.key]: scalarValue } as SettingsWriteDelta);
            } else {
                owner.writeLocalSettings({ [binding.key]: scalarValue } as Partial<LocalSettings>);
            }
            return { anchor: ref.anchor, value: binding.invertBoolean ? !scalarValue : scalarValue };
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
