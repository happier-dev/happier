import { isHomeSignInPlatformSetting } from '@happier-dev/protocol';
import type {
  HomeSettingEntryV1,
  HomeSettingsProjectionV1,
} from '@happier-dev/protocol/home/governance';
import { SERVER_CONFIG_REGISTRY_BASE } from '@happier-dev/protocol/serverConfig/registry';

import { buildSettingHref } from '@/components/settings/catalog/settingDeclarations';
import type { IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import { homeSettingIgnoredReasonLabel } from '../governance/homeServerSettingLabels';
import { homeAdministrationSignInProvidersPath } from '../governance/homeAdministrationRoutes';
import { HOME_SIGN_IN_PROVIDERS_SETTINGS } from './homeSignInProvidersSettings';

/**
 * The sign-in platforms a Home holds credentials for (AM-12, lab `hcSignin-R*`): the registry
 * groups `isHomeSignInPlatformSetting` moves off Server settings, gathered into the two apps a
 * person recognises. Which keys are the credential pair a platform needs is the one fact this
 * module adds; everything else (value, lock, pending, ignored) is the `home.settings.get` answer.
 */
export type HomeSignInPlatformId = 'github' | 'workos';

/** What a missing required key is called in the row's summary ("Needs a client ID"). */
export type HomeSignInPlatformNeed = 'clientId' | 'clientSecret' | 'apiKey';

type PlatformDeclaration = Readonly<{
  id: HomeSignInPlatformId;
  groups: readonly string[];
  /** The pair the platform cannot work without, in the order the row asks for them. */
  required: readonly Readonly<{ key: string; need: HomeSignInPlatformNeed }>[];
  /** Keys shown with the pair because setting the platform up needs them (the callback address). */
  details?: readonly string[];
  /** Keys that decide who may sign in through the platform, shown as their own group. */
  access?: readonly string[];
}>;

const PLATFORMS: readonly PlatformDeclaration[] = [
  {
    id: 'github',
    groups: ['github', 'oauth'],
    required: [
      { key: 'GITHUB_CLIENT_ID', need: 'clientId' },
      { key: 'GITHUB_CLIENT_SECRET', need: 'clientSecret' },
    ],
    details: ['GITHUB_REDIRECT_URL'],
    access: [
      'AUTH_GITHUB_ALLOWED_USERS',
      'AUTH_GITHUB_ALLOWED_ORGS',
      'AUTH_GITHUB_ORG_MATCH',
      'AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE',
    ],
  },
  {
    id: 'workos',
    groups: ['workos'],
    required: [
      { key: 'WORKOS_CLIENT_ID', need: 'clientId' },
      { key: 'WORKOS_API_KEY', need: 'apiKey' },
    ],
  },
];

/**
 * One row shape in every state; only the summary changes (lab `hcSignin-RX`). Precedence follows
 * what the owner must act on first: a value the last start could not use, then a saved change the
 * server has not applied, then a missing credential, then the ready states.
 */
export type HomeSignInPlatformState =
  | Readonly<{ kind: 'ignored'; entry: HomeSettingEntryV1 }>
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'not_set' }>
  | Readonly<{ kind: 'partly_set'; need: HomeSignInPlatformNeed }>
  /** Every required key is set by the deployment: nothing here can change it. */
  | Readonly<{ kind: 'locked' }>
  /** Ready; `partlyLocked` when the deployment sets one of the pair, which `lockedNeed` names. */
  | Readonly<{
      kind: 'ready';
      partlyLocked: boolean;
      lockedNeed?: HomeSignInPlatformNeed;
    }>;

export type HomeSignInPlatform = Readonly<{
  id: HomeSignInPlatformId;
  /** The credential pair, in order; absent keys (an older Home) are left out. */
  primary: readonly HomeSettingEntryV1[];
  /** What setting the platform up also needs (GitHub's callback address), after the pair. */
  details: readonly HomeSettingEntryV1[];
  /** Who may sign in through the platform (GitHub's allowed people and organizations). */
  access: readonly HomeSettingEntryV1[];
  /** Every other key of the platform's groups, in registry order. */
  advanced: readonly HomeSettingEntryV1[];
  state: HomeSignInPlatformState;
}>;

function hasValue(entry: HomeSettingEntryV1): boolean {
  if (entry.secretSet !== undefined) return entry.secretSet;
  const value = entry.value;
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return !Array.isArray(value) || value.length > 0;
}

function platformState(
  platform: PlatformDeclaration,
  entries: readonly HomeSettingEntryV1[],
  byKey: ReadonlyMap<string, HomeSettingEntryV1>,
): HomeSignInPlatformState {
  const ignored = entries.find(
    (entry) => entry.applied?.ignoredReason !== undefined,
  );
  if (ignored) return { kind: 'ignored', entry: ignored };
  if (entries.some((entry) => entry.applied?.pending === true))
    return { kind: 'pending' };
  const required = platform.required.flatMap(({ key, need }) => {
    const entry = byKey.get(key);
    return entry ? [{ entry, need }] : [];
  });
  const missing = required.filter(({ entry }) => !hasValue(entry));
  if (required.length === 0 || missing.length === required.length)
    return { kind: 'not_set' };
  if (missing.length > 0) return { kind: 'partly_set', need: missing[0]!.need };
  const fixed = required.filter(({ entry }) => entry.fixed);
  if (fixed.length === required.length) return { kind: 'locked' };
  return fixed.length > 0
    ? { kind: 'ready', partlyLocked: true, lockedNeed: fixed[0]!.need }
    : { kind: 'ready', partlyLocked: false };
}

/** The platforms this Home projects, each with its rows and its one-line state. */
export function selectHomeSignInPlatforms(
  settings: HomeSettingsProjectionV1,
): readonly HomeSignInPlatform[] {
  const byKey = new Map(settings.entries.map((entry) => [entry.key, entry]));
  const result: HomeSignInPlatform[] = [];
  for (const platform of PLATFORMS) {
    const entries = settings.entries.filter((entry) => {
      const declaration = entry.declaration;
      return (
        entry.editable === 'home' &&
        declaration !== undefined &&
        isHomeSignInPlatformSetting(declaration) &&
        declaration.group !== undefined &&
        platform.groups.includes(declaration.group)
      );
    });
    if (entries.length === 0) continue;
    const requiredKeys = platform.required.map(({ key }) => key);
    const primary = requiredKeys.flatMap(
      (key) => entries.find((entry) => entry.key === key) ?? [],
    );
    const pick = (keys: readonly string[] | undefined) =>
      (keys ?? []).flatMap(
        (key) => entries.find((entry) => entry.key === key) ?? [],
      );
    const details = pick(platform.details);
    const access = pick(platform.access);
    const placed = new Set(
      [...primary, ...details, ...access].map((entry) => entry.key),
    );
    const advanced = entries.filter((entry) => !placed.has(entry.key));
    result.push(
      Object.freeze({
        id: platform.id,
        primary,
        details,
        access,
        advanced,
        state: platformState(platform, entries, byKey),
      }),
    );
  }
  return result;
}

/** Which of a platform's credentials `key` is, or `null` for any other key. */
export function homeSignInPlatformKeyNeed(
  key: string,
): HomeSignInPlatformNeed | null {
  for (const platform of PLATFORMS) {
    const found = platform.required.find((required) => required.key === key);
    if (found) return found.need;
  }
  return null;
}

/** A credential as its field is titled inside the platform's own row ("Client ID"). */
export function homeSignInPlatformFieldTitle(
  need: HomeSignInPlatformNeed,
): string {
  switch (need) {
    case 'clientId':
      return t('homeGovernance.signInProviders.fieldClientId');
    case 'clientSecret':
      return t('homeGovernance.signInProviders.fieldClientSecret');
    case 'apiKey':
      return t('homeGovernance.signInProviders.fieldApiKey');
  }
}

/**
 * A platform's mark, wherever it is named. WorkOS has no brand mark in the icon set yet, so it
 * stands on one stand-in glyph here rather than one per surface.
 */
export function homeSignInPlatformIcon(id: HomeSignInPlatformId): IconName {
  return id === 'github' ? 'github-logo' : 'shield-check';
}

export function homeSignInPlatformTitle(id: HomeSignInPlatformId): string {
  return id === 'github'
    ? t('homeGovernance.signInProviders.githubSignIn')
    : t('identityAdministration.workos');
}

/** What a missing credential is called, as the row and the Overview say it. */
export function homeSignInPlatformNeedLabel(
  need: HomeSignInPlatformNeed,
): string {
  switch (need) {
    case 'clientId':
      return t('homeGovernance.signInProviders.needsClientId');
    case 'clientSecret':
      return t('homeGovernance.signInProviders.needsClientSecret');
    case 'apiKey':
      return t('homeGovernance.signInProviders.needsApiKey');
  }
}

/** The closed row's one state line (lab `hcSignin-RX`): what it means for people, never key names. */
export function homeSignInPlatformSummary(
  platform: HomeSignInPlatform,
  facts: Readonly<{ githubSignInOn: boolean }>,
): string {
  const state = platform.state;
  switch (state.kind) {
    case 'ignored':
      return state.entry.applied?.ignoredReason
        ? t('homeSettings.row.ignored', {
            reason: homeSettingIgnoredReasonLabel(
              state.entry.applied.ignoredReason,
            ),
          })
        : pendingSummary(platform.id);
    case 'pending':
      return pendingSummary(platform.id);
    case 'not_set':
      return platform.id === 'github'
        ? t('homeGovernance.signInProviders.notSetGithub')
        : t('homeGovernance.signInProviders.notSetWorkos');
    case 'partly_set':
      return homeSignInPlatformNeedLabel(state.need);
    case 'locked':
      return t('homeGovernance.signInProviders.lockedSummary');
    case 'ready':
      // The deployment sets one of the pair: the line names which (lab `hcSignin-RL`).
      if (state.lockedNeed)
        return t('homeGovernance.signInProviders.readyPartlyLocked', {
          setting: homeSignInPlatformFieldTitle(state.lockedNeed),
        });
      if (platform.id === 'workos')
        return t('homeGovernance.signInProviders.readyWorkos');
      return facts.githubSignInOn
        ? t('homeGovernance.signInProviders.readyGithubOn')
        : t('homeGovernance.signInProviders.readyGithubOff');
  }
}

/** A saved change says what it will do once applied, per platform (lab `hcSignin-RX`). */
function pendingSummary(id: HomeSignInPlatformId): string {
  return id === 'github'
    ? t('homeGovernance.signInProviders.pendingSummaryGithub')
    : t('homeGovernance.signInProviders.pendingSummaryWorkos');
}

/**
 * The platform whose row sets every one of `keys`, when the Home can set them all itself — the
 * place a "needs …" sentence links to instead of naming env keys (DR-03). `null` when any key is
 * not a Home-editable platform key, so only the deployment can provide it.
 */
export function homeSignInPlatformForKeys(keys: readonly string[]): HomeSignInPlatformId | null {
  let found: HomeSignInPlatformId | null = null;
  for (const key of keys) {
    const entry = SERVER_CONFIG_REGISTRY_BASE[key];
    if (!entry || entry.editable !== 'home' || !isHomeSignInPlatformSetting(entry)) return null;
    const platform = PLATFORMS.find((candidate) => entry.group !== undefined && candidate.groups.includes(entry.group));
    if (!platform || (found !== null && found !== platform.id)) return null;
    found = platform.id;
  }
  return found;
}

/** Sign-in providers, at the Home's company sign-in collection. */
export function homeCompanySignInHref(serverId: string): string {
  return buildSettingHref(
    homeAdministrationSignInProvidersPath(serverId),
    HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.homeConnections,
  );
}

/** Sign-in providers, opened at the platform's row (its disclosure opens on arrival). */
export function homeSignInPlatformHref(serverId: string, id: HomeSignInPlatformId): string {
  const setting = id === 'github'
    ? HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.githubSignIn
    : HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.workos;
  return buildSettingHref(homeAdministrationSignInProvidersPath(serverId), setting);
}
