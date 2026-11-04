import { Platform } from 'react-native';
import type { AccountSettingKey, AutomationV3Settings, FeatureId, PluginContributionIdentityV1, SettingsDeclarationOperationInputV1, StrictJsonValueSchema } from '@happier-dev/protocol';

import type { TranslationKeyNoParams } from '@/text';
import { desktopHostKind, isDesktopHost } from '@/utils/platform/desktopHost';

import type { SettingsPageId } from './types';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import type { Settings, WritableSettingsKey } from '@/sync/domains/settings/settings';
import type { SettingsWriteDelta } from '@/sync/domains/settings/settings';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { ACCOUNT_SETTING_DEFINITIONS } from '@happier-dev/protocol/account/settings/accountSettings';
import type { z } from 'zod/mini';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { SettingsDeclarationTargetKindV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import type { TeamSettingBindingV1, SettingsOwnerActionExecuteV1 } from '@happier-dev/protocol/actions';
import { BUILT_IN_SETTINGS_DECLARATIONS_V1, readBuiltInSettingDeclarationV1, readPortableDomainSettingBindingV1,
    readPortablePlatformAccountSettingBindingV1,
    parseBuiltInAccountSettingValueV1, readBuiltInAccountSettingValueV1, buildBuiltInAccountSettingMutationV1,
    type PortableSettingDeclarationV1 } from '@happier-dev/protocol/actions/settings/settingsDeclarations';
import { BUILT_IN_SETTINGS_METADATA_V1 } from '@happier-dev/protocol/actions/settings/builtInSettingsMetadata';
import type { AtmospherePresentation } from '@happier-dev/protocol/account/settings/accountSettings';

export type SettingValue = z.infer<typeof SettingsDeclarationValueV1Schema>;
export type SettingScalarValue = Extract<SettingValue, string | number | boolean | null>;
/** Scalar controls retain their admission contract within the wider JSON Action value. */
export function parseSettingScalarValue(value: unknown) {
    const parsed = SettingsDeclarationValueV1Schema.safeParse(value);
    return parsed.success && (parsed.data === null || typeof parsed.data !== 'object')
        ? { success: true as const, value: parsed.data } : { success: false as const };
}
/** An unavailable owner value is not an unset preference; never serialize this sentinel. */
export const SETTING_VALUE_UNAVAILABLE = Symbol('setting_value_unavailable');
export type SettingOwnerMutation = (settings: Settings) => SettingsWriteDelta | null;
/** Domain-owned Settings consumers use the captured canonical Action executor. */
export type SettingsOwnerActionExecute = SettingsOwnerActionExecuteV1;
export type SettingOperationContext = Readonly<{
    signal?: AbortSignal;
    accountScope?: ServerAccountScope;
    input?: SettingsDeclarationOperationInputV1;
    target?: import('@happier-dev/protocol/actions/settingsDeclarationActionFamily').SettingsDeclarationTargetV1;
    isCurrent(): boolean;
    isFeatureEnabled?: (featureId: FeatureId) => Promise<boolean>;
    readSettings(): Promise<Settings>;
    mutateSettings(mutate: SettingOwnerMutation, options?: Readonly<{ rebaseOnConflict: boolean }>): Promise<void>;
    /** Device effects use the answering client's captured Settings owner, never global storage. */
    readLocalSettings?: () => LocalSettings;
    writeLocalSettings?: (delta: Partial<LocalSettings>) => void;
    /** Alias to a control published by this client's current mounted surface. */
    openMountedControl?: (anchor: string) => Promise<boolean>;
    services?: SettingsMutationServices;
}>;
export type SettingOperationResult = Readonly<{
    status: 'completed' | 'cancelled' | 'unavailable' | 'interaction_opened';
    reason?: string;
    value?: z.infer<typeof StrictJsonValueSchema>;
}>;
export type SettingsMutationServices = Readonly<{
    /** Native model transfer presentation belongs to this mounted invocation, never Action input. */
    voiceModelPackPresentation?: Pick<import('@/voice/settings/voiceDeviceModelPackOperation').VoiceDeviceModelPackOperationInput,
        'onDownloadStarted' | 'onProgress' | 'onUpdateChecked'> & Readonly<{
            isCurrent(): boolean;
            /** Keep native recovery/error presentation local without serializing installer errors. */
            onError?(error: unknown): void;
        }>;
    /** Captured editor snapshots stay host-private; the public compound intent carries only null. */
    voiceSettingsEdit?: Readonly<{
        before: Settings['voice'];
        next: Settings['voice'];
        isLanguageOwnerCurrent(voice: Settings['voice']): boolean;
    }>;
    /** Captured controller, never looked up from caller input or current focus. */
    publicProfileAtmosphereDraft?: Readonly<{
        serverId: string;
        isCurrent(): boolean;
        read(): AtmospherePresentation;
        update(edit: (value: AtmospherePresentation) => AtmospherePresentation): void | Promise<void>;
    }>;
    /** The host owns native picker custody; Action input carries no local bytes or URI. */
    pickAtmospherePicture?: (signal?: AbortSignal) => Promise<Blob | string | null>;
    readAtmospherePictureLibrary?: (signal?: AbortSignal) => Promise<SettingValue>;
    projectAccountRows?: Pick<ReturnType<typeof import('@/sync/api/projects/projectAccountRowsClient').createUiProjectAccountRowsClient>, 'read' | 'mutateOrganization'>;
    readAtmospherePictureFile?: (input: Readonly<{ machineId: string; path: string }>, signal?: AbortSignal) => Promise<
        Readonly<{ success: true; content: string }> | Readonly<{ success: false; error: string }>>;
    readConnectedAccountPurposes?: (signal?: AbortSignal) => Promise<import('@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1').ConnectedPurposeCatalogV1 | null>;
    executeSettingsOwnerAction?: SettingsOwnerActionExecute;
    purgeAccountSettingsHistory?: (versions: readonly number[], signal?: AbortSignal) => Promise<
        Readonly<{ status: 'complete' }> | Readonly<{ status: 'cleanup-pending'; versions: readonly number[] }>>;
    restoreAccountSettingsHistory?: (input: Extract<SettingsDeclarationOperationInputV1, { kind: 'account_settings_history_restore' }>, signal?: AbortSignal) => Promise<SettingOperationResult>;
    convertAccountEncryptionMode?: (toMode: 'plain' | 'e2ee', signal?: AbortSignal) => Promise<SettingOperationResult>;
    readScmDiffSummaryCatalog?: (settings: Settings, storedValue: string) => Promise<Readonly<{
        profiles: readonly import('@/settings/scmDiffSummary/settings').ScmDiffSummaryCatalogProfile[];
        isCurrent: (settings: Settings) => boolean;
    }> | null>;
    readAgentCatalog?: (settings: Settings) => Promise<Readonly<{
        entries: readonly import('@/agents/backendCatalog/agentCatalogProjection').ResolvedAgentCatalogEntry[];
        isCurrent: (settings: Settings) => boolean;
    }> | null>;
}>;

type ScalarSettingKeys<T> = { [K in keyof T]: T[K] extends string | number | boolean | null | undefined ? K : never }[keyof T] & string;
/** Explicitly admitted preference; declarations never infer a writer from a row id. */
export type SettingStorageBinding = Readonly<{
    access: 'read_write' | 'read_only' | 'sensitive';
    /** Choices supplied by the owning control when its write contract is narrower than storage. */
    allowedValues?: readonly (string | number | boolean | null)[];
    /** The row's positive boolean answer is stored as an opt-out preference. */
    invertBoolean?: boolean;
}> & (
    | Readonly<{ scope: 'home'; kind: 'homeSettings'; key: string }>
    | Readonly<{ scope: 'project'; kind: 'projectAtmosphere' }>
    | Readonly<{ scope: 'local'; kind: 'atmospherePictureLibrary' }>
    | Readonly<{ scope: 'home'; kind: 'sessionAutoFollowPreferences'; field: 'assigned' | 'direct' | 'team' | 'group' }>
    | TeamSettingBindingV1
    | Readonly<{ scope: 'account'; key: AccountSettingKey & WritableSettingsKey }>
    | Readonly<{ scope: 'local'; key: ScalarSettingKeys<LocalSettings> }>
    | Readonly<{
        scope: 'account';
        kind: 'automationSettings';
        /** These fields belong to the server Automation record, not synced Account preferences. */
        field: keyof AutomationV3Settings;
    }>
    | Readonly<{
        scope: 'account';
        kind: 'owner';
        /** Compound presentation owners reset through their admitted default intent. */
        resetValue?: SettingValue;
        read: (settings: Settings) => unknown;
        parse: (value: unknown) => Readonly<{ success: true; value: SettingValue }> | Readonly<{ success: false }>;
        /** Applied inside the Account CAS owner, including every conflict rebase. */
        mutate: (settings: Settings, value: SettingValue) => SettingsWriteDelta | null;
        /** Resolve a catalog choice before CAS; the returned intent rechecks its captured authority. */
        prepare?: (settings: Settings, value: SettingValue, services: SettingsMutationServices, context?: Readonly<{ signal?: AbortSignal; isCurrent(): boolean }>) => Promise<SettingOwnerMutation | null>;
    }>
    | Readonly<{
        scope: 'local';
        kind: 'localOwner';
        /** Compatibility state owners preserve the reset intent of their former local field. */
        resetValue?: SettingValue;
        /** Device state keyed to an Account cannot be discovered as usable before that authority is captured. */
        requiresAccountScope?: true;
        read: (local: LocalSettings, context?: Readonly<{ accountScope?: ServerAccountScope; readSettings?: () => Promise<Settings> }>) => unknown;
        parse: (value: unknown) => Readonly<{ success: true; value: SettingValue }> | Readonly<{ success: false }>;
        /**
         * Writes through the device setting's owner, which may apply more than storage (the running
         * theme and status bar) or keep sibling fields of a nested record.
         */
        commit: (local: LocalSettings, value: SettingValue, writeLocal: (delta: Partial<LocalSettings>) => void,
            context?: Readonly<{ signal?: AbortSignal; isCurrent(): boolean; readLocalSettings?: () => LocalSettings;
                accountScope?: ServerAccountScope; readSettings?: () => Promise<Settings>;
                /** Compound device owners persist their account-owned facts through the admitted CAS owner. */
                mutateSettings?: (mutate: SettingOwnerMutation) => Promise<void> }>) =>
            void | typeof SETTING_VALUE_UNAVAILABLE | Promise<void | typeof SETTING_VALUE_UNAVAILABLE>;
    }>
);

/** Accepted addresses derive from the declaration's actual domain owner, never a parallel catalog. */
export function settingTargetKinds(binding: SettingStorageBinding | undefined, anchor?: string): readonly SettingsDeclarationTargetKindV1[] {
    const declared = readBuiltInSettingDeclarationV1(anchor)?.targetKinds;
    if (declared?.length) return declared;
    if (binding?.scope === 'project') return ['project'];
    if (binding?.scope === 'home') return ['home'];
    if (binding?.scope === 'team') return [binding.kind === 'teamIdentityConnection' ? 'team_identity_connection' : 'team'];
    return [];
}

/**
 * Settings declared by a page so search can find them individually.
 *
 * The portable registry owns each built-in id, label and placement. A page attaches host callbacks
 * and renders its projected declaration (`SettingRow`). The label on screen and the label search
 * matches are therefore the same value by construction, and every setting has a stable anchor
 * (`<pageId>.<settingId>`, or `<pageId>.<subpageId>.<settingId>` on a sub-page) that search can
 * navigate to.
 *
 * What a declaration can say about when its row exists:
 * - `host`: the row exists only on some hosts (a platform or the desktop app). Static for the life of
 *   the app, so search never offers the row elsewhere, and the page renders it under the same
 *   predicate (`settingRendersOnHost`).
 * - `featureId` (portable rows or sections): the row or section renders only while that feature
 *   is on; search follows. Mixed sections preserve each portable row's own feature decision.
 * - Anything else (another setting's value, a selected machine, a feature being off) is page state.
 *   Search still offers the row; when the page opens without it, the enclosing `SettingSection`
 *   reveals the section instead, whose own state line says what the row needs.
 * A row that no page state can ever render is not declared.
 */

/** The host the app runs on, as far as settings rows care. */
export type SettingsHost = Readonly<{
    os: typeof Platform.OS;
    /** A desktop shell (Tauri or Electron); its web view reports `os: 'web'`. */
    desktop: boolean;
}>;

/** Whether a row can exist on this host at all. */
export type SettingsHostPredicate = (host: SettingsHost) => boolean;

/** The host predicates rows use; name new ones here rather than inlining them in declarations. */
export const settingsHosts = {
    ios: (host) => host.os === 'ios',
    native: (host) => host.os === 'ios' || host.os === 'android',
    web: (host) => host.os === 'web',
    notWeb: (host) => host.os !== 'web',
    desktop: (host) => host.desktop,
    /** The Tauri shell in particular (asked of the desktop host only when a row needs it). */
    tauriDesktop: (host) => host.desktop && desktopHostKind() === 'tauri',
    iosOrDesktop: (host) => host.os === 'ios' || host.desktop,
} satisfies Readonly<Record<string, SettingsHostPredicate>>;

export function resolveSettingsHost(): SettingsHost {
    return { os: Platform.OS, desktop: isDesktopHost() };
}

export type SettingDeclaration = Readonly<{
    /** Retain a portable setting's canonical identity when its row lives on another page. */
    anchor?: string;
    /** Built-in labels are projected by defineSettingsPage from the portable registry. */
    titleKey?: TranslationKeyNoParams;
    descriptionKey?: TranslationKeyNoParams;
    /** Resolved author-owned label for contribution fields; never a host translation-key cast. */
    title?: string;
    description?: string;
    /** Activation-owned contribution fields may only use their admitted Account's projection. */
    contribution?: PluginContributionIdentityV1;
    /** Extra searchable words, as translation keys so they are found in every language. */
    keywordKeys?: readonly TranslationKeyNoParams[];
    /** The row exists only on these hosts. */
    host?: SettingsHostPredicate;
    /** Omit when the row has no canonical value reader and write admission owner. */
    storage?: SettingStorageBinding;
    /** Secret-bearing rows remain discoverable without exposing or changing their value. */
    sensitive?: boolean;
    /** Operations keep their incumbent selection/trust owner instead of becoming a value write. */
    operation?: Readonly<{ requiresHumanInteraction: true; kind: 'interaction' }> | Readonly<{
        requiresHumanInteraction: boolean;
        /** Consumed by the incumbent Actions approval policy, never by an operation-local gate. */
        requiresApproval?: boolean;
        /** A direct UI gesture or owner consent dialog supplies the default interaction. Explicit Ask still applies. */
        uiConfirmation?: 'direct' | 'policy';
        kind: 'invoke';
        invoke(input: SettingOperationContext): Promise<SettingOperationResult>;
    }>;
}>;

export type SettingsSectionDeclaration = Readonly<{
    titleKey?: TranslationKeyNoParams;
    /** Resolved author-owned section label for contribution sections (a service's own name). */
    title?: string;
    /** The section renders only while this feature is on; search offers its settings under the same condition. */
    featureId?: FeatureId;
    /** The section exists only on these hosts. */
    host?: SettingsHostPredicate;
    settings: Readonly<Record<string, SettingDeclaration>>;
}>;

export type SettingRef = Omit<SettingDeclaration, 'host' | 'titleKey'> & Readonly<{
    titleKey: TranslationKeyNoParams;
    /** `<pageId>.<settingId>`: the row anchor and the search result identity. */
    anchor: string;
    /** The enclosing section's id (`SettingsSectionRef.id`), revealed when the row is not rendered. */
    sectionId: string;
    sectionTitleKey?: TranslationKeyNoParams;
    /** The section's resolved author-owned label, when it has no translation key. */
    sectionTitle?: string;
    featureId?: FeatureId;
    /** The section's and the row's host predicates together. */
    host?: SettingsHostPredicate;
}>;

/** A declared section, for `SettingSection`: the rows it holds and the id its reveal answers to. */
export type SettingsSectionRef = Readonly<{
    /** `<pageId>.<sectionId>` (with the sub-page id on a sub-page). Never a URL anchor. */
    id: string;
    settingAnchors: readonly string[];
}>;

type SettingIds<Sections extends Record<string, SettingsSectionDeclaration>> = {
    [Section in keyof Sections]: keyof Sections[Section]['settings'] & string;
}[keyof Sections];

/** The selected Settings leaf's explicit route inputs; this is not an entity inventory. */
export type SettingsRouteContext = Readonly<{
    pathname: string;
    params: Readonly<Record<string, string | string[] | undefined>>;
}>;

/** Scoped destinations consume explicit identity, never a focused Home; null omits an unbound row. */
export type SettingsSubpageRoute = string | ((context: SettingsRouteContext) => string | null);

/**
 * A page reached from a catalog page (a link row) rather than from the rail. Its settings belong to
 * the catalog page (visibility, search result identity) but live on the sub-page's own route.
 */
export type SettingsSubpageDeclaration = Readonly<{
    /** Joins the anchor: `<pageId>.<subpageId>.<settingId>`. */
    id: string;
    route: SettingsSubpageRoute;
    titleKey: TranslationKeyNoParams;
    /**
     * `page`: the rows moved here from the catalog page and keep its anchors (`<pageId>.<settingId>`),
     * so their shared ids, links and Actions resolve unchanged; only where they open differs.
     */
    anchors?: 'page';
}>;

export type SettingsPageDeclaration<Sections extends Record<string, SettingsSectionDeclaration> = Record<string, SettingsSectionDeclaration>> = Readonly<{
    pageId: SettingsPageId;
    subpage?: SettingsSubpageDeclaration;
    sections: Sections;
    /** Every declared section, keyed by its id, ready to hand to `SettingSection`. */
    sectionRefs: Readonly<Record<keyof Sections & string, SettingsSectionRef>>;
    /** Every declared setting, keyed by its id, ready to hand to `SettingRow`. */
    settings: Readonly<Record<SettingIds<Sections>, SettingRef>>;
}>;

function combineHostPredicates(
    section: SettingsHostPredicate | undefined,
    setting: SettingsHostPredicate | undefined,
): SettingsHostPredicate | undefined {
    if (!section) return setting;
    if (!setting) return section;
    return (host) => section(host) && setting(host);
}

// The app validates shared translation keys while the portable owner stays independent of UI.
const portableUiLabels: readonly Readonly<{
    anchor: string; titleKey: TranslationKeyNoParams; descriptionKey?: TranslationKeyNoParams;
    keywordKeys?: readonly TranslationKeyNoParams[]; sectionTitleKey?: TranslationKeyNoParams;
    featureId?: FeatureId;
    labelVariants?: Readonly<Record<string, Readonly<{
        titleKey: TranslationKeyNoParams; descriptionKey?: TranslationKeyNoParams; keywordKeys?: readonly TranslationKeyNoParams[];
    }>>>;
}>[] = BUILT_IN_SETTINGS_METADATA_V1;
const portableLabelsByAnchor = new Map(portableUiLabels.map(declaration => [declaration.anchor, declaration]));

/** Pages whose rows have no host callbacks take their structure directly from the shared owner. */
export function builtInSettingsPageSections(anchorPrefix: string): Record<string, SettingsSectionDeclaration> {
    const sections: Record<string, SettingsSectionDeclaration> = {};
    for (const declaration of BUILT_IN_SETTINGS_DECLARATIONS_V1) {
        if (!declaration.sectionId.startsWith(`${anchorPrefix}.`)) continue;
        const sectionId = declaration.sectionId.slice(anchorPrefix.length + 1);
        if (sectionId.includes('.')) continue;
        const labels = portableLabelsByAnchor.get(declaration.anchor);
        const section = sections[sectionId] ?? { titleKey: labels?.sectionTitleKey, settings: {} };
        const id = declaration.anchor.slice(anchorPrefix.length + 1);
        sections[sectionId] = { ...section, settings: { ...section.settings, [id]: {} } };
    }
    return sections;
}

function portableStorageBinding(declaration: PortableSettingDeclarationV1): SettingStorageBinding | undefined {
    const binding = declaration.storage;
    if (!binding) return undefined;
    if (binding.scope === 'local' && binding.kind === 'atmospherePictureLibrary') return { scope: 'local', kind: 'atmospherePictureLibrary', access: 'read_only' };
    if (binding.scope === 'project' && binding.kind === 'projectAtmosphere') return { scope: 'project', kind: 'projectAtmosphere', access: binding.access };
    const platformBinding = readPortablePlatformAccountSettingBindingV1(declaration, Platform.OS === 'web' ? 'web' : 'native');
    if (platformBinding) return platformBinding;
    const domain = readPortableDomainSettingBindingV1(declaration);
    if (domain) return domain;
    if (binding.scope === 'account' && binding.kind === 'automationSettings'
        && (binding.field === 'maxActiveRunsPerMachine' || binding.field === 'runRetention')) return {
        scope: 'account', kind: 'automationSettings', field: binding.field, access: binding.access,
        allowedValues: binding.allowedValues,
    };
    if (binding.scope === 'account' && (!binding.kind || binding.kind === 'field') && binding.key) {
        if (binding.kind === 'field') return {
            scope: 'account', kind: 'owner', access: binding.access, allowedValues: binding.allowedValues,
            read: settings => readBuiltInAccountSettingValueV1(declaration, settings),
            parse: value => parseBuiltInAccountSettingValueV1(declaration, value),
            mutate: (settings, value) => buildBuiltInAccountSettingMutationV1(declaration, settings, value) as SettingsWriteDelta | null,
        };
        if (!Object.hasOwn(ACCOUNT_SETTING_DEFINITIONS, binding.key)) throw new Error(`Unknown Account setting: ${declaration.anchor}`);
        return { scope: 'account', key: binding.key as AccountSettingKey & WritableSettingsKey,
            access: binding.access, allowedValues: binding.allowedValues, invertBoolean: binding.invertBoolean };
    }
    if (binding.scope === 'local' && !binding.kind && binding.key) return {
        scope: 'local', key: binding.key as ScalarSettingKeys<LocalSettings>, access: binding.access,
        allowedValues: binding.allowedValues, invertBoolean: binding.invertBoolean,
    };
    return undefined;
}

function projectPortableDeclaration(anchor: string, adapter: SettingDeclaration, labelVariant?: string): SettingDeclaration & { titleKey: TranslationKeyNoParams } {
    const portable = readBuiltInSettingDeclarationV1(anchor);
    const baseLabels = portableLabelsByAnchor.get(anchor);
    const labels = labelVariant ? baseLabels?.labelVariants?.[labelVariant] ?? baseLabels : baseLabels;
    if (!portable || !labels) {
        // Plugin contributions retain their activation-owned projection, not a second built-in list.
        if (adapter.contribution && adapter.titleKey) return { ...adapter, titleKey: adapter.titleKey };
        throw new Error(`Undeclared built-in setting: ${anchor}`);
    }
    const callbackStorage = adapter.storage && 'kind' in adapter.storage
        && (adapter.storage.kind === 'owner' || adapter.storage.kind === 'localOwner')
        ? adapter.storage : undefined;
    if (callbackStorage && (!portable.storage || callbackStorage.scope !== portable.storage.scope)) {
        throw new Error(`Setting adapter placement differs from its shared declaration: ${anchor}`);
    }
    const storage = callbackStorage && portable.storage
        ? { ...callbackStorage, access: portable.storage.access, allowedValues: portable.storage.allowedValues ?? callbackStorage.allowedValues }
        : portableStorageBinding(portable);
    const operation = adapter.operation && portable.operation
        ? portable.operation.kind === 'interaction'
            ? { kind: 'interaction' as const, requiresHumanInteraction: true as const }
            : adapter.operation.kind === 'invoke'
                ? { ...adapter.operation, ...portable.operation, kind: 'invoke' as const }
                : undefined
        : adapter.operation;
    return {
        ...adapter, titleKey: labels.titleKey, descriptionKey: labels.descriptionKey, keywordKeys: labels.keywordKeys,
        sensitive: portable.sensitive, storage, operation,
    };
}

export function builtInSettingUiDeclaration(anchor: string, labelVariant?: string): SettingDeclaration & { titleKey: TranslationKeyNoParams } {
    return projectPortableDeclaration(anchor, {}, labelVariant);
}

/** Picker preferences have portable value owners without pretending to be searchable page rows. */
export function readBuiltInAccountSettingUiRef(anchor: string, ownerBinding?: Readonly<{
    owner: string;
    storage: Extract<SettingStorageBinding, { scope: 'account'; kind: 'owner' }>;
}>): SettingRef | null {
    const portable = readBuiltInSettingDeclarationV1(anchor);
    const labels = portableLabelsByAnchor.get(anchor);
    if (!portable || !labels || portable.operation) return null;
    if (ownerBinding && portable.storage?.owner !== ownerBinding.owner) return null;
    const declaration = projectPortableDeclaration(anchor, ownerBinding ? { storage: ownerBinding.storage } : {});
    if (declaration.storage?.scope !== 'account' || !('key' in declaration.storage) && !ownerBinding) return null;
    return { ...declaration, anchor, sectionId: portable.sectionId,
        sectionTitleKey: labels.sectionTitleKey, featureId: labels.featureId };
}

export function defineSettingsPage<const Sections extends Record<string, SettingsSectionDeclaration>>(input: Readonly<{
    pageId: SettingsPageId;
    subpage?: SettingsSubpageDeclaration;
    sections: Sections;
}>): SettingsPageDeclaration<Sections> {
    const settings: Record<string, SettingRef> = {};
    const declaredAnchors = new Set<string>();
    const sectionRefs: Record<string, SettingsSectionRef> = {};
    const sections: Record<string, SettingsSectionDeclaration> = {};
    const anchorPrefix = input.subpage && input.subpage.anchors !== 'page' ? `${input.pageId}.${input.subpage.id}` : input.pageId;
    for (const [sectionKey, section] of Object.entries(input.sections)) {
        const sectionId = `${anchorPrefix}.${sectionKey}`;
        const firstSettingId = Object.keys(section.settings)[0];
        const sharedSection = firstSettingId
            ? portableLabelsByAnchor.get(section.settings[firstSettingId]?.anchor ?? `${anchorPrefix}.${firstSettingId}`)
            : undefined;
        const sectionTitleKey = sharedSection ? sharedSection.sectionTitleKey : section.titleKey;
        // A mixed section (Files and SCM preferences) has row gates, not a gate inherited
        // from whichever row happens to come first.
        const sectionFeatures = new Set(Object.entries(section.settings).map(([id, declaration]) =>
            portableLabelsByAnchor.get(declaration.anchor ?? `${anchorPrefix}.${id}`)?.featureId));
        const featureId = sharedSection
            ? sectionFeatures.size === 1 ? sharedSection.featureId : undefined
            : section.featureId;
        sections[sectionKey] = { ...section, titleKey: sectionTitleKey, featureId };
        const settingAnchors: string[] = [];
        for (const [settingId, declaration] of Object.entries(section.settings)) {
            if (settings[settingId]) {
                throw new Error(`Duplicate setting id "${settingId}" on settings page "${input.pageId}"`);
            }
            const anchor = declaration.anchor ?? `${anchorPrefix}.${settingId}`;
            if (declaredAnchors.has(anchor)) throw new Error(`Duplicate setting anchor "${anchor}" on settings page "${input.pageId}"`);
            declaredAnchors.add(anchor);
            const portable = readBuiltInSettingDeclarationV1(anchor);
            if (portable && portable.sectionId !== sectionId) {
                throw new Error(`Setting adapter section differs from its shared declaration: ${anchor}`);
            }
            const { host, ...label } = projectPortableDeclaration(anchor, declaration);
            const combinedHost = combineHostPredicates(section.host, host);
            const rowFeatureId = portableLabelsByAnchor.get(anchor)?.featureId ?? featureId;
            settingAnchors.push(anchor);
            settings[settingId] = {
                ...label,
                anchor,
                sectionId,
                sectionTitleKey,
                ...(!sharedSection && section.title ? { sectionTitle: section.title } : {}),
                ...(rowFeatureId ? { featureId: rowFeatureId } : {}),
                ...(combinedHost ? { host: combinedHost } : {}),
            };
        }
        sectionRefs[sectionKey] = { id: sectionId, settingAnchors };
    }
    return {
        pageId: input.pageId,
        subpage: input.subpage,
        sections: sections as Sections,
        sectionRefs: sectionRefs as SettingsPageDeclaration<Sections>['sectionRefs'],
        settings: settings as SettingsPageDeclaration<Sections>['settings'],
    };
}

/** Whether a declared row exists on this host. Pages render host-bound rows under this, as search offers them. */
export function settingRendersOnHost(ref: Pick<SettingRef, 'host'>, host: SettingsHost = resolveSettingsHost()): boolean {
    return ref.host ? ref.host(host) : true;
}

/** Every feature a declared section or row is gated on: the catalog evaluates exactly these. */
export function collectDeclaredFeatureIds(declarations: readonly SettingsPageDeclaration[]): FeatureId[] {
    const ids = new Set<FeatureId>();
    for (const declaration of declarations) {
        for (const section of Object.values(declaration.sections)) {
            if (section.featureId) ids.add(section.featureId);
        }
        for (const ref of Object.values(declaration.settings)) {
            if (ref.featureId) ids.add(ref.featureId);
        }
    }
    return [...ids];
}

/** The route query parameter that names the setting a page should reveal. */
export const SETTING_ANCHOR_QUERY_PARAM = 'setting';

/** The link that opens a settings page and reveals one declared setting on it. */
export function buildSettingHref<Route extends string>(route: Route, ref: Pick<SettingRef, 'anchor'>): `${Route}${'?' | '&'}setting=${string}`;
export function buildSettingHref(route: SettingsSubpageRoute, ref: Pick<SettingRef, 'anchor'>, context?: SettingsRouteContext): string | null;
export function buildSettingHref(route: SettingsSubpageRoute, ref: Pick<SettingRef, 'anchor'>, context?: SettingsRouteContext): string | null {
    const destination = typeof route === 'string' ? route : context ? route(context) : null;
    if (destination === null) return null;
    const separator = destination.includes('?') ? '&' : '?';
    return `${destination}${separator}${SETTING_ANCHOR_QUERY_PARAM}=${encodeURIComponent(ref.anchor)}`;
}
