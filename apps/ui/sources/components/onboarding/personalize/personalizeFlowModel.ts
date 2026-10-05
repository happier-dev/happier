import {
    readLocalNotificationPreference,
    resolveLocalNotificationPreferenceDelta,
    type LocalNotificationPreferenceId,
} from '@/components/settings/notifications/localNotificationPreferences';
import {
    resolveThinkingDisplayChoice,
    resolveThinkingDisplayChoiceDelta,
    type ThinkingDisplayChoice,
} from '@/components/settings/session/thinkingDisplayChoice';
import { readGlassPreset, resolveGlassPresetSettingsDelta, type GlassMaterialChoice, type GlassMaterialSettings } from '@/components/ui/glass/glassMaterial';
import {
    resolveSessionListLayoutChoice,
    resolveSessionListLayoutSettingsDelta,
    type SessionListLayoutChoice,
} from '@/sync/domains/session/listing/sessionListLayout';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import type { Settings, SettingsWriteDelta } from '@/sync/domains/settings/settings';

/**
 * Personalize Happier: six choices, each saved on Next through the setting's own writer. This module
 * owns what the flow reads, what each step writes, the optional starting styles that only pre-fill,
 * and the device-local visit memory that lets the Home card resume. It owns no preference of its own.
 */

/** The Home "Get set up" entry; completing or dismissing hides `setup:personalize`. */
export const PERSONALIZE_SETUP_ENTRY_ID = 'personalize';

export const PERSONALIZE_STEPS = ['look', 'conversation', 'tools', 'work', 'attention', 'notifications'] as const;
export type PersonalizeStepId = typeof PERSONALIZE_STEPS[number];

/** Look comes first (it opens in place on Home); the optional starting style sits right before the steps it pre-fills. */
export const PERSONALIZE_PAGES = ['look', 'style', 'conversation', 'tools', 'work', 'attention', 'notifications', 'summary'] as const;
export type PersonalizePageId = typeof PERSONALIZE_PAGES[number];

export type ThemeModeChoice = 'adaptive' | 'light' | 'dark';
export type ToolChromeChoice = 'activity_feed' | 'cards';
export type ToolDetailChoice = Settings['toolViewDetailLevelDefault'];
export type ListDensityChoice = 'detailed' | 'cozy' | 'narrow';
export type AttentionPlacementChoice = 'off' | 'withinGroups' | 'global';

export type PersonalizeChoices = Readonly<{
    theme: ThemeModeChoice;
    /** `custom` is a table the person tuned in Appearance; the flow keeps it unless a preset is picked. */
    glass: GlassMaterialChoice;
    /** The visit's original material inputs, retained for an exact draft preview without global writes. */
    glassSettings: GlassMaterialSettings;
    transcriptLayout: 'turns' | 'linear';
    thinking: ThinkingDisplayChoice;
    toolChrome: ToolChromeChoice;
    toolDetail: ToolDetailChoice;
    toolTap: 'expand' | 'open';
    listLayout: SessionListLayoutChoice;
    listDensity: ListDensityChoice;
    attention: AttentionPlacementChoice;
    /** This device: approvals and questions (permission and user-action requests together). */
    notifyNeedsYou: boolean;
    /** This device: a session finished its turn. */
    notifyFinished: boolean;
    /** This device: banners show the message rather than only the status. */
    notifyPreview: boolean;
}>;

type NotificationSettings = Pick<LocalSettings, 'attentionDeviceOverridesV1'>;

export function readPersonalizeChoices(account: Settings, local: Pick<LocalSettings, 'themePreference' | 'attentionDeviceOverridesV1'>): PersonalizeChoices {
    const notificationsOn = readLocalNotificationPreference(local, 'enabled');
    const read = (id: LocalNotificationPreferenceId) => readLocalNotificationPreference(local, id);
    return {
        theme: local.themePreference === 'light' || local.themePreference === 'dark' ? local.themePreference : 'adaptive',
        glass: readGlassPreset(account),
        glassSettings: {
            glassBlurEnabled: account.glassBlurEnabled,
            glassBlurIntensity: account.glassBlurIntensity,
            glassSurfaceMaterials: account.glassSurfaceMaterials,
        },
        transcriptLayout: account.transcriptGroupingMode === 'linear' ? 'linear' : 'turns',
        thinking: resolveThinkingDisplayChoice(account),
        toolChrome: account.toolViewTimelineChromeMode === 'cards' ? 'cards' : 'activity_feed',
        toolDetail: account.toolViewDetailLevelDefault,
        toolTap: account.toolViewTapAction === 'open' ? 'open' : 'expand',
        listLayout: resolveSessionListLayoutChoice(account),
        listDensity: account.sessionListDensity,
        attention: account.sessionListAttentionPromotionModeV1,
        notifyNeedsYou: notificationsOn && read('permissionRequests') && read('userActions'),
        notifyFinished: notificationsOn && read('ready'),
        notifyPreview: read('readyPreview') && read('requestPreview'),
    };
}

export type PersonalizeStepWrite = Readonly<{
    /** Account preferences, one write through the Account settings writer. */
    account: SettingsWriteDelta | null;
    /** This device's preferences. */
    local: Partial<LocalSettings> | null;
    /** The theme mode goes through the theme owner, which also applies it. */
    theme: ThemeModeChoice | null;
}>;

const NO_WRITE: PersonalizeStepWrite = { account: null, local: null, theme: null };

function accountWrite(delta: Record<string, unknown>): PersonalizeStepWrite {
    return Object.keys(delta).length === 0 ? NO_WRITE : { ...NO_WRITE, account: delta as SettingsWriteDelta };
}

/** What Next writes for one step: only the choices that differ from the current settings. */
export function resolvePersonalizeStepWrite(
    step: PersonalizeStepId,
    draft: PersonalizeChoices,
    account: Settings,
    local: Pick<LocalSettings, 'themePreference' | 'attentionDeviceOverridesV1'>,
): PersonalizeStepWrite {
    const current = readPersonalizeChoices(account, local);
    switch (step) {
        case 'look': {
            const glass = draft.glass !== 'custom' && draft.glass !== current.glass
                ? resolveGlassPresetSettingsDelta(account, draft.glass)
                : null;
            const theme = draft.theme !== current.theme ? draft.theme : null;
            return { account: glass, local: null, theme };
        }
        case 'conversation':
            return accountWrite({
                ...(draft.transcriptLayout !== current.transcriptLayout ? { transcriptGroupingMode: draft.transcriptLayout } : {}),
                ...(draft.thinking !== current.thinking ? resolveThinkingDisplayChoiceDelta(draft.thinking) : {}),
            });
        case 'tools':
            return accountWrite({
                ...(draft.toolChrome !== current.toolChrome ? { toolViewTimelineChromeMode: draft.toolChrome } : {}),
                ...(draft.toolDetail !== current.toolDetail ? { toolViewDetailLevelDefault: draft.toolDetail } : {}),
                ...(draft.toolTap !== current.toolTap ? { toolViewTapAction: draft.toolTap } : {}),
            });
        case 'work':
            return accountWrite({
                ...(draft.listLayout !== current.listLayout ? resolveSessionListLayoutSettingsDelta(draft.listLayout, account) : {}),
                ...(draft.listDensity !== current.listDensity ? { sessionListDensity: draft.listDensity } : {}),
            });
        case 'attention':
            return accountWrite(draft.attention !== current.attention ? { sessionListAttentionPromotionModeV1: draft.attention } : {});
        case 'notifications':
            return resolveNotificationsWrite(draft, current, local);
    }
}

function resolveNotificationsWrite(
    draft: PersonalizeChoices,
    current: PersonalizeChoices,
    local: NotificationSettings,
): PersonalizeStepWrite {
    if (draft.notifyNeedsYou === current.notifyNeedsYou
        && draft.notifyFinished === current.notifyFinished
        && draft.notifyPreview === current.notifyPreview) return NO_WRITE;
    // Once the step changed, every stored field matches what the step shows, so turning this device's
    // notifications on cannot revive an event the person left off.
    let next: NotificationSettings = local;
    const set = (id: LocalNotificationPreferenceId, value: boolean) => {
        if (readLocalNotificationPreference(next, id) !== value) next = resolveLocalNotificationPreferenceDelta(next, id, value);
    };
    set('permissionRequests', draft.notifyNeedsYou);
    set('userActions', draft.notifyNeedsYou);
    set('ready', draft.notifyFinished);
    set('readyPreview', draft.notifyPreview);
    set('requestPreview', draft.notifyPreview);
    // Choosing to be told about something turns this device's notifications on; choosing nothing leaves the switch alone.
    if (draft.notifyNeedsYou || draft.notifyFinished) set('enabled', true);
    return next === local ? NO_WRITE : { ...NO_WRITE, local: { attentionDeviceOverridesV1: next.attentionDeviceOverridesV1 } };
}

// --- Starting styles ------------------------------------------------------------------------------

export const STARTING_STYLES = ['activity', 'conversation', 'detail'] as const;
export type StartingStyleId = typeof STARTING_STYLES[number];

/** The choices a style pre-fills. Theme, notifications, privacy and agent permissions are never part of a style. */
export const STARTING_STYLE_FIELDS = ['transcriptLayout', 'thinking', 'toolChrome', 'toolDetail', 'listDensity'] as const;
export type StartingStyleField = typeof STARTING_STYLE_FIELDS[number];

const STARTING_STYLE_CHOICES: Readonly<Record<StartingStyleId, Pick<PersonalizeChoices, StartingStyleField>>> = {
    // Happier's defaults.
    activity: { transcriptLayout: 'turns', thinking: 'inline_summary', toolChrome: 'activity_feed', toolDetail: 'default', listDensity: 'narrow' },
    conversation: { transcriptLayout: 'turns', thinking: 'inline_summary', toolChrome: 'cards', toolDetail: 'default', listDensity: 'cozy' },
    detail: { transcriptLayout: 'linear', thinking: 'inline_full', toolChrome: 'cards', toolDetail: 'full', listDensity: 'detailed' },
};

export function readStartingStyle(style: StartingStyleId): Pick<PersonalizeChoices, StartingStyleField> {
    return STARTING_STYLE_CHOICES[style];
}

/** The style the current values amount to, or null ("Custom"). Computed, never stored. */
export function matchStartingStyle(choices: PersonalizeChoices): StartingStyleId | null {
    return STARTING_STYLES.find(style => listStartingStyleChanges(choices, style).length === 0) ?? null;
}

export function applyStartingStyle(choices: PersonalizeChoices, style: StartingStyleId): PersonalizeChoices {
    return { ...choices, ...STARTING_STYLE_CHOICES[style] };
}

export type StartingStyleChange = Readonly<{ field: StartingStyleField; from: string; to: string }>;

export function listStartingStyleChanges(choices: PersonalizeChoices, style: StartingStyleId): StartingStyleChange[] {
    const target = STARTING_STYLE_CHOICES[style];
    return STARTING_STYLE_FIELDS.flatMap(field => choices[field] === target[field]
        ? []
        : [{ field, from: String(choices[field]), to: String(target[field]) }]);
}

// --- Progress (device-local visit memory) ---------------------------------------------------------

export type PersonalizeProgress = Readonly<{
    savedSteps: readonly PersonalizeStepId[];
    resumeAt: PersonalizePageId | null;
}>;

export const EMPTY_PERSONALIZE_PROGRESS: PersonalizeProgress = { savedSteps: [], resumeAt: null };

/** The stored visit memory, with ids from another build dropped. */
export function normalizePersonalizeProgress(raw: Readonly<{ savedSteps: readonly string[]; resumeAt: string | null }> | null | undefined): PersonalizeProgress {
    if (!raw) return EMPTY_PERSONALIZE_PROGRESS;
    const savedSteps = PERSONALIZE_STEPS.filter(step => raw.savedSteps.includes(step));
    const resumeAt = (PERSONALIZE_PAGES as readonly string[]).includes(raw.resumeAt ?? '') ? raw.resumeAt as PersonalizePageId : null;
    return { savedSteps, resumeAt };
}

export function nextPersonalizePage(page: PersonalizePageId): PersonalizePageId | null {
    return PERSONALIZE_PAGES[PERSONALIZE_PAGES.indexOf(page) + 1] ?? null;
}

export function previousPersonalizePage(page: PersonalizePageId): PersonalizePageId | null {
    const index = PERSONALIZE_PAGES.indexOf(page);
    return index > 0 ? PERSONALIZE_PAGES[index - 1]! : null;
}

export function isPersonalizeStep(page: PersonalizePageId): page is PersonalizeStepId {
    return (PERSONALIZE_STEPS as readonly string[]).includes(page);
}

export function recordPersonalizeStepSaved(progress: PersonalizeProgress, step: PersonalizeStepId): PersonalizeProgress {
    const savedSteps = progress.savedSteps.includes(step)
        ? progress.savedSteps
        : PERSONALIZE_STEPS.filter(candidate => candidate === step || progress.savedSteps.includes(candidate));
    return { savedSteps, resumeAt: nextPersonalizePage(step) };
}

export function recordPersonalizePageSkipped(progress: PersonalizeProgress, page: PersonalizePageId): PersonalizeProgress {
    return { savedSteps: progress.savedSteps, resumeAt: nextPersonalizePage(page) ?? page };
}

export function resolvePersonalizeResumePage(progress: PersonalizeProgress): PersonalizePageId {
    return progress.resumeAt ?? 'look';
}

export type PersonalizeCardProgress = Readonly<{
    started: boolean;
    savedCount: number;
    /** The step the card offers to pick up at; null once only the summary is left. */
    nextStep: PersonalizeStepId | null;
}>;

export function resolvePersonalizeCardProgress(progress: PersonalizeProgress): PersonalizeCardProgress {
    const resume = resolvePersonalizeResumePage(progress);
    const resumeIndex = PERSONALIZE_PAGES.indexOf(resume);
    const nextStep = PERSONALIZE_STEPS.find(step => PERSONALIZE_PAGES.indexOf(step) >= resumeIndex) ?? null;
    return {
        started: progress.resumeAt !== null || progress.savedSteps.length > 0,
        savedCount: progress.savedSteps.length,
        nextStep,
    };
}
