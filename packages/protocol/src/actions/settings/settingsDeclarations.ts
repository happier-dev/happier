import { ACCOUNT_SETTING_DEFINITIONS, accountSettingsParse, type AccountSettingKey } from '../../account/settings/accountSettings.js';
import { SettingsDeclarationActionInputSchemasV1, SettingsDeclarationValueV1Schema, type SettingsDeclarationActionIdV1, type SettingsDeclarationTargetKindV1 } from '../settingsDeclarationActionFamily.js';
import { BUILT_IN_SETTINGS_METADATA_V1 } from './builtInSettingsMetadata.js';
import type { z } from 'zod/mini';
import type { TeamSettingBindingV1 } from './settingsOwnerActions.js';
import { readPortableAccountSettingBindingV1 } from './accountSettingBindings.js';

export type PortableSettingStorageV1 = Readonly<{
  scope: 'account' | 'local' | 'home' | 'team' | 'project';
  kind?: string;
  key?: string;
  field?: string;
  path?: readonly string[];
  access: 'read_write' | 'read_only' | 'sensitive';
  allowedValues?: readonly (string | number | boolean | null)[];
  invertBoolean?: boolean;
  owner?: string;
  options?: readonly unknown[];
  mode?: string;
  /** Some settings require the answering client's platform or picture release catalog. */
  prerequisite?: 'ui_platform' | 'ui_picture_catalog' | 'ui_account_encryption_requirement';
}>;
export type PortableSettingDeclarationV1 = Readonly<{
  anchor: string;
  pageId: string;
  sectionId: string;
  titleKey: string;
  title: string;
  descriptionKey?: string;
  description?: string;
  keywordKeys?: readonly string[];
  labelVariants?: Readonly<Record<string, Readonly<{ titleKey: string; title: string; descriptionKey?: string; description?: string; keywordKeys?: readonly string[] }>>>;
  sectionTitleKey?: string;
  featureId?: string;
  storage?: PortableSettingStorageV1;
  targetKinds: readonly SettingsDeclarationTargetKindV1[];
  sensitive: boolean;
  /** Explicit permission-policy meaning, independent of sensitive content and safety. */
  permissionChanging?: true;
  /** Host-authored safety for reversible personal preferences; omission retains danger. */
  agentSafety?: 'safe' | 'danger';
  operation?: Readonly<{ kind: 'interaction' | 'invoke'; requiresHumanInteraction: boolean; requiresApproval?: boolean; uiConfirmation?: 'direct' | 'policy'; owner?: string; options?: readonly string[] }>;
}>;

const builtInSettingsDeclarations: readonly PortableSettingDeclarationV1[] = BUILT_IN_SETTINGS_METADATA_V1;
/** Portable discovery excludes the mounted editor's private, null-only binding. */
export const BUILT_IN_SETTINGS_DECLARATIONS_V1: readonly PortableSettingDeclarationV1[] = builtInSettingsDeclarations.filter(
  declaration => declaration.storage?.owner !== 'voiceSettingsEditBinding',
);
// Approval and host-intent admission still resolve the canonical private declaration.
const declarationsByAnchor = new Map(builtInSettingsDeclarations.map(declaration => [declaration.anchor, declaration]));
export function readBuiltInSettingDeclarationV1(anchor: unknown): PortableSettingDeclarationV1 | null {
  return typeof anchor === 'string' ? declarationsByAnchor.get(anchor) ?? null : null;
}

/** One declaration-owned default for static and activation-owned Settings operations. */
export function resolveSettingsDeclarationOperationApprovalPolicyV1(operation: Readonly<{
  kind: 'interaction' | 'invoke'; requiresApproval?: boolean; uiConfirmation?: 'direct' | 'policy';
}> | undefined): Readonly<{ requiresApproval: boolean; uiConfirmationRequired: boolean }> {
  const requiresApproval = operation?.kind !== 'invoke' || operation.requiresApproval !== false;
  return { requiresApproval, uiConfirmationRequired: requiresApproval && operation?.uiConfirmation !== 'direct' };
}

/** Unknown operations fail closed; Action inputs never declare their own confirmation policy. */
export function readBuiltInSettingsOperationApprovalPolicyV1(input: unknown): ReturnType<typeof resolveSettingsDeclarationOperationApprovalPolicyV1> {
  const anchor = input !== null && typeof input === 'object' && 'anchor' in input ? input.anchor : undefined;
  return resolveSettingsDeclarationOperationApprovalPolicyV1(readBuiltInSettingDeclarationV1(anchor)?.operation);
}

/** Action inputs select an existing declaration; they cannot supply their own safety. */
export function readBuiltInSettingsPermissionChangingV1(input: unknown, kind: 'write' | 'invoke' = 'write'): boolean {
  const canChange = (declaration: PortableSettingDeclarationV1) => declaration.permissionChanging === true
    && (kind === 'invoke' ? Boolean(declaration.operation) : declaration.storage?.access === 'read_write');
  if (input === undefined) return builtInSettingsDeclarations.some(canChange);
  const anchor = input !== null && typeof input === 'object' && 'anchor' in input ? input.anchor : undefined;
  const declaration = readBuiltInSettingDeclarationV1(anchor);
  return declaration ? canChange(declaration) : false;
}

/** Action inputs select an existing declaration; they cannot supply their own safety. */
export function readBuiltInSettingsWriteSafetyV1(input: unknown): 'safe' | 'danger' {
  const anchor = input !== null && typeof input === 'object' && 'anchor' in input ? input.anchor : undefined;
  const declaration = readBuiltInSettingDeclarationV1(anchor);
  return declaration?.agentSafety === 'safe' && !declaration.sensitive
    && declaration.storage?.access === 'read_write' ? 'safe' : 'danger';
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

const THEME_MODE_PHRASES: Readonly<Record<string, string>> = {
  adaptive: 'Follow the system appearance', light: 'Switch to light mode', dark: 'Switch to dark mode',
};

/** A preset id such as `premiumDark` reads as "Premium dark" when the value carries no profile name. */
function humanizeThemeProfileId(id: string): string {
  const words = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : id;
}

function describeThemeModeValue(value: unknown): string | null {
  if (typeof value === 'string') return THEME_MODE_PHRASES[value] ?? null;
  const record = readRecord(value);
  if (!record) return null;
  const activation = readRecord(record.activation);
  if (activation) {
    const profile = readRecord(activation.profile);
    const profileId = typeof activation.profileId === 'string' ? activation.profileId : null;
    const name = typeof profile?.name === 'string' && profile.name.trim() ? profile.name.trim()
      : profileId ? humanizeThemeProfileId(profileId) : 'Default';
    const scope = activation.profileMode === 'light' ? ' for light mode' : activation.profileMode === 'dark' ? ' for dark mode'
      : ' for light and dark mode';
    return `Use “${name}”${scope}`;
  }
  return typeof record.themePreference === 'string' ? THEME_MODE_PHRASES[record.themePreference] ?? null : null;
}

/**
 * A device-owned compound value (a theme selection carries profile ids, timestamps and schema versions)
 * reads as the choice it makes. Declarations whose value is already a short scalar need no description.
 */
export function describeSettingsDeclarationValueV1(declaration: PortableSettingDeclarationV1, value: unknown): string | null {
  // This host-private compound edit has no public replacement value to review.
  if (declaration.storage?.owner === 'voiceSettingsEditBinding' && value === null) return `Change “${declaration.title}”`;
  return declaration.storage?.owner === 'themeModeStorageBinding' ? describeThemeModeValue(value) : null;
}

/** The review shows a described value in place of its raw members; other inputs pass through unchanged. */
export function projectSettingsDeclarationApprovalInputV1(actionId: SettingsDeclarationActionIdV1, input: unknown): unknown {
  const parsed = SettingsDeclarationActionInputSchemasV1[actionId].safeParse(input);
  if (!parsed.success || actionId !== 'settings.set' || !('anchor' in parsed.data) || !('value' in parsed.data)) return input;
  const declaration = readBuiltInSettingDeclarationV1(parsed.data.anchor);
  const described = declaration ? describeSettingsDeclarationValueV1(declaration, parsed.data.value) : null;
  return described === null ? input : { ...parsed.data, value: described };
}

/** Approval copy consumes the same declaration that names the setting on its page and in discovery. */
export function describeSettingsDeclarationApprovalSummaryV1(actionId: SettingsDeclarationActionIdV1, input: unknown): string | null {
  const parsed = SettingsDeclarationActionInputSchemasV1[actionId].safeParse(input);
  if (!parsed.success || !('anchor' in parsed.data)) return null;
  const declaration = readBuiltInSettingDeclarationV1(parsed.data.anchor);
  if (!declaration) return null;
  const name = `“${declaration.title}”`;
  const described = actionId === 'settings.set' && 'value' in parsed.data ? describeSettingsDeclarationValueV1(declaration, parsed.data.value) : null;
  const effect = described !== null ? `${described}.` : actionId === 'settings.set'
    ? `Change ${name}${!declaration.sensitive && 'value' in parsed.data && (parsed.data.value === null || typeof parsed.data.value !== 'object')
      ? ` to ${JSON.stringify(parsed.data.value)}` : ''}.`
    : actionId === 'settings.reset' ? `Reset ${name} to its default.`
      : actionId === 'settings.invoke' ? `Run ${name}.` : null;
  return effect && declaration.description ? `${effect} ${declaration.description}` : effect;
}

/** No headless default: the current row's meaning depends on its observed UI platform. */
export function readPortablePlatformAccountSettingBindingV1(declaration: PortableSettingDeclarationV1, platform: 'web' | 'native' | null):
  Readonly<{ scope: 'account'; key: 'agentInputEnterToSend' | 'agentInputEnterToSendNative'; access: PortableSettingStorageV1['access'] }> | null {
  const storage = declaration.storage;
  if (storage?.scope !== 'account' || storage.owner !== 'composerEnterToSend' || (platform !== 'web' && platform !== 'native')) return null;
  const key = storage.options?.[platform === 'web' ? 0 : 1];
  if (key !== 'agentInputEnterToSend' && key !== 'agentInputEnterToSendNative') return null;
  return { scope: 'account', key, access: storage.access };
}

/** Host callbacks attach execution only; operation consent is authored in the same registry. */
export function readBuiltInSettingsOperationPolicyV1(owner: string, options: readonly string[]): PortableSettingDeclarationV1['operation'] | null {
  return BUILT_IN_SETTINGS_DECLARATIONS_V1.find(declaration => declaration.operation?.owner === owner
    && declaration.operation.options?.length === options.length
    && options.every((value, index) => declaration.operation?.options?.[index] === value))?.operation ?? null;
}

export function readPortableDomainSettingBindingV1(declaration: PortableSettingDeclarationV1):
  TeamSettingBindingV1 | Readonly<{ scope: 'home'; kind: 'homeSettings'; key: string; access: PortableSettingStorageV1['access'] }>
  | Readonly<{ scope: 'home'; kind: 'sessionAutoFollowPreferences'; field: 'assigned' | 'direct' | 'team' | 'group'; access: PortableSettingStorageV1['access'] }> | null {
  const binding = declaration.storage;
  if (!binding) return null;
  const { access } = binding;
  if (binding.scope === 'home' && binding.kind === 'homeSettings' && binding.key) return { scope: 'home', kind: binding.kind, key: binding.key, access };
  if (binding.scope === 'home' && binding.kind === 'sessionAutoFollowPreferences'
    && (binding.field === 'assigned' || binding.field === 'direct' || binding.field === 'team' || binding.field === 'group')) return { scope: 'home', kind: binding.kind, field: binding.field, access };
  if (binding.scope !== 'team') return null;
  if (binding.kind === 'teamAdmissionMode' && (binding.mode === 'invite_only' || binding.mode === 'provisioned' || binding.mode === 'jit')) return { scope: 'team', kind: binding.kind, mode: binding.mode, access };
  if (binding.kind === 'teamAuthentication' && (binding.field === 'inherit' || binding.field === 'restricted' || binding.field === 'accepted')) return { scope: 'team', kind: binding.kind, field: binding.field, access };
  if (binding.kind === 'teamIdentityConnection' && (binding.field === 'allowedUsers' || binding.field === 'allowedEmailDomains' || binding.field === 'groupsAny' || binding.field === 'groupsAll' || binding.field === 'organizationLogin')) return { scope: 'team', kind: binding.kind, field: binding.field, access };
  return null;
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}
function readPath(value: unknown, path: readonly string[]): unknown {
  return path.reduce((current, key) => object(current)[key], value);
}
function replacePath(value: unknown, path: readonly string[], next: unknown): unknown {
  const [key, ...rest] = path;
  if (!key) return next;
  const current = object(value);
  return { ...current, [key]: replacePath(current[key], rest, next) };
}
type AccountSettingDeclarationBindingV1 = Pick<PortableSettingDeclarationV1, 'storage' | 'sensitive'>;

function accountDefinition(declaration: AccountSettingDeclarationBindingV1) {
  const binding = declaration.storage;
  if (binding?.scope !== 'account' || !binding.key || binding.kind && binding.kind !== 'field') return null;
  return Object.hasOwn(ACCOUNT_SETTING_DEFINITIONS, binding.key)
    ? ACCOUNT_SETTING_DEFINITIONS[binding.key as AccountSettingKey] : null;
}

/** Unbound rows remain discoverable; readers must not confuse them with an unset value. */
export function hasBuiltInAccountSettingBindingV1(declaration: AccountSettingDeclarationBindingV1): boolean {
  return declaration.storage?.scope === 'account'
    && (readPortableAccountSettingBindingV1(declaration) !== null || accountDefinition(declaration) !== null);
}

/** Strict incoming admission; stored-reader recovery defaults cannot admit malformed writes. */
export function parseBuiltInAccountSettingValueV1(declaration: AccountSettingDeclarationBindingV1, value: unknown):
  Readonly<{ success: true; value: z.infer<typeof SettingsDeclarationValueV1Schema> }> | Readonly<{ success: false }> {
  const binding = declaration.storage;
  const owner = readPortableAccountSettingBindingV1(declaration);
  if (owner) {
    if (binding?.access !== 'read_write' || declaration.sensitive) return { success: false };
    if (binding.allowedValues && !binding.allowedValues.includes(value as string | number | boolean | null)) return { success: false };
    return owner.parse(value);
  }
  const definition = accountDefinition(declaration);
  if (!binding || !definition || binding.access !== 'read_write' || declaration.sensitive) return { success: false };
  const json = SettingsDeclarationValueV1Schema.safeParse(value);
  if (!json.success || binding.allowedValues && !binding.allowedValues.includes(json.data as string | number | boolean | null)) return { success: false };
  if (binding.invertBoolean && typeof json.data !== 'boolean') return { success: false };
  const defaultValue = binding.path ? readPath(definition.default, binding.path) : definition.default;
  // Account schemas may recover legacy persisted values with coercion. Action writes are a
  // stricter boundary: a scalar intent must already have the canonical scalar type.
  const defaultType = typeof defaultValue;
  if ((defaultType === 'boolean' || defaultType === 'number' || defaultType === 'string')
    && typeof json.data !== defaultType) return { success: false };
  const stored = binding.invertBoolean ? !json.data : json.data;
  const parsed = definition.parseMutationValue(binding.path ? replacePath(definition.default, binding.path, stored) : stored);
  if (!parsed.success) return { success: false };
  const projected = binding.path ? readPath(parsed.data, binding.path) : parsed.data;
  const result = SettingsDeclarationValueV1Schema.safeParse(binding.invertBoolean ? !projected : projected);
  return result.success ? { success: true, value: result.data } : { success: false };
}

export function readBuiltInAccountSettingValueV1(declaration: AccountSettingDeclarationBindingV1, settings: Readonly<Record<string, unknown>>): unknown {
  const owner = readPortableAccountSettingBindingV1(declaration);
  if (owner) return owner.read(accountSettingsParse(settings));
  const binding = declaration.storage;
  if (!accountDefinition(declaration) || !binding?.key) return undefined;
  const value = binding.path ? readPath(settings[binding.key], binding.path) : settings[binding.key];
  return binding.invertBoolean && typeof value === 'boolean' ? !value : value;
}

/** Reset is a validated default intent, never replacement of an owning settings object. */
export function resolveBuiltInAccountSettingResetValueV1(declaration: AccountSettingDeclarationBindingV1, key?: unknown):
  ReturnType<typeof parseBuiltInAccountSettingValueV1> {
  const owner = readPortableAccountSettingBindingV1(declaration);
  if (owner?.reset) return owner.reset(key);
  return parseBuiltInAccountSettingValueV1(declaration,
    readBuiltInAccountSettingValueV1(declaration, accountSettingsParse({})));
}

/** Sparse intent rebuilt against every latest Account snapshot by the existing CAS writer. */
export function buildBuiltInAccountSettingMutationV1(declaration: AccountSettingDeclarationBindingV1, settings: Readonly<Record<string, unknown>>, value: unknown):
  Readonly<Record<string, unknown>> | null {
  const binding = declaration.storage;
  const owner = readPortableAccountSettingBindingV1(declaration);
  if (owner) {
    const admitted = parseBuiltInAccountSettingValueV1(declaration, value);
    return admitted.success ? owner.mutate(accountSettingsParse(settings), admitted.value) : null;
  }
  const definition = accountDefinition(declaration);
  const admitted = parseBuiltInAccountSettingValueV1(declaration, value);
  if (!binding?.key || !definition || !admitted.success) return null;
  const stored = binding.invertBoolean ? !admitted.value : admitted.value;
  const parsed = definition.parseMutationValue(binding.path ? replacePath(settings[binding.key], binding.path, stored) : stored);
  return parsed.success ? { [binding.key]: parsed.data } : null;
}
