import {
    readLocalNotificationPreference,
    type LocalNotificationPreferenceId,
} from '@/components/settings/notifications/localNotificationPreferences';
import {
    resolveThinkingDisplayChoice,
    type ThinkingDisplayChoice,
} from '@/components/settings/session/thinkingDisplayChoice';
import { readGlassPreset, readGlassTintIntensity, type GlassMaterialChoice, type GlassMaterialSettings } from '@/components/ui/glass/glassMaterial';
import {
    resolveSessionListLayoutChoice,
    type SessionListLayoutChoice,
} from '@/sync/domains/session/listing/sessionListLayout';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import type { Settings } from '@/sync/domains/settings/settings';

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
export type AttentionPlacementChoice = Settings['sessionListAttentionPlacementV1'];

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

export function readPersonalizeChoices(account: Settings, local: Pick<LocalSettings, 'themePreference' | 'attentionDeviceOverridesV1'>): PersonalizeChoices {
    const notificationsOn = readLocalNotificationPreference(local, 'enabled');
    const read = (id: LocalNotificationPreferenceId) => readLocalNotificationPreference(local, id);
    return {
        theme: local.themePreference === 'light' || local.themePreference === 'dark' ? local.themePreference : 'adaptive',
        glass: readGlassPreset(account),
        glassSettings: {
            glassBlurEnabled: account.glassBlurEnabled,
            glassBlurIntensity: account.glassBlurIntensity,
            glassTintIntensity: readGlassTintIntensity(account.glassTintIntensity),
            glassSurfaceMaterials: account.glassSurfaceMaterials,
        },
        transcriptLayout: account.transcriptGroupingMode === 'linear' ? 'linear' : 'turns',
        thinking: resolveThinkingDisplayChoice(account),
        toolChrome: account.toolViewTimelineChromeMode === 'cards' ? 'cards' : 'activity_feed',
        toolDetail: account.toolViewDetailLevelDefault,
        toolTap: account.toolViewTapAction === 'open' ? 'open' : 'expand',
        listLayout: resolveSessionListLayoutChoice(account),
        listDensity: account.sessionListDensity,
        attention: account.sessionListAttentionPlacementV1,
        notifyNeedsYou: notificationsOn && read('permissionRequests') && read('userActions'),
        notifyFinished: notificationsOn && read('ready'),
        notifyPreview: read('readyPreview') && read('requestPreview'),
    };
}

/** Existing declared choices; their owners resolve compound storage mutations at commit time. */
export type PersonalizeSettingWrite = Readonly<
    | { anchor: 'appearance.glassPreset'; value: Exclude<GlassMaterialChoice, 'custom'> }
    | { anchor: 'transcript.layoutPicker'; value: PersonalizeChoices['transcriptLayout'] }
    | { anchor: 'transcript.displayMode'; value: ThinkingDisplayChoice }
    | { anchor: 'transcript.timelineChrome'; value: ToolChromeChoice }
    | { anchor: 'transcript.defaultToolDetailLevel'; value: ToolDetailChoice }
    | { anchor: 'transcript.cardTapAction'; value: PersonalizeChoices['toolTap'] }
    | { anchor: 'session.list.layout'; value: SessionListLayoutChoice }
    | { anchor: 'session.list.density'; value: ListDensityChoice }
    | { anchor: 'session.list.attentionPlacement'; value: AttentionPlacementChoice }
    | { anchor: 'notifications.localPermissionRequests' | 'notifications.localUserActions'
        | 'notifications.ready' | 'notifications.readyPreview' | 'notifications.requestPreview'
        | 'notifications.localEnabled'; value: boolean }
>;

export type PersonalizeStepWrite = Readonly<{
    settings: readonly PersonalizeSettingWrite[];
    /** The theme mode goes through the theme owner, which also applies it. */
    theme: ThemeModeChoice | null;
}>;

const NO_WRITE: PersonalizeStepWrite = { settings: [], theme: null };

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
            const theme = draft.theme !== current.theme ? draft.theme : null;
            return { settings: draft.glass !== 'custom' && draft.glass !== current.glass
                ? [{ anchor: 'appearance.glassPreset', value: draft.glass }] : [], theme };
        }
        case 'conversation':
            return { ...NO_WRITE, settings: [
                ...(draft.transcriptLayout !== current.transcriptLayout ? [{ anchor: 'transcript.layoutPicker' as const, value: draft.transcriptLayout }] : []),
                ...(draft.thinking !== current.thinking ? [{ anchor: 'transcript.displayMode' as const, value: draft.thinking }] : []),
            ] };
        case 'tools':
            return { ...NO_WRITE, settings: [
                ...(draft.toolChrome !== current.toolChrome ? [{ anchor: 'transcript.timelineChrome' as const, value: draft.toolChrome }] : []),
                ...(draft.toolDetail !== current.toolDetail ? [{ anchor: 'transcript.defaultToolDetailLevel' as const, value: draft.toolDetail }] : []),
                ...(draft.toolTap !== current.toolTap ? [{ anchor: 'transcript.cardTapAction' as const, value: draft.toolTap }] : []),
            ] };
        case 'work':
            return { ...NO_WRITE, settings: [
                ...(draft.listLayout !== current.listLayout ? [{ anchor: 'session.list.layout' as const, value: draft.listLayout }] : []),
                ...(draft.listDensity !== current.listDensity ? [{ anchor: 'session.list.density' as const, value: draft.listDensity }] : []),
            ] };
        case 'attention':
            return { ...NO_WRITE, settings: draft.attention !== current.attention
                ? [{ anchor: 'session.list.attentionPlacement', value: draft.attention }] : [] };
        case 'notifications':
            return resolveNotificationsWrite(draft, current, local);
    }
}

function resolveNotificationsWrite(
    draft: PersonalizeChoices,
    current: PersonalizeChoices,
    local: Pick<LocalSettings, 'attentionDeviceOverridesV1'>,
): PersonalizeStepWrite {
    if (draft.notifyNeedsYou === current.notifyNeedsYou
        && draft.notifyFinished === current.notifyFinished
        && draft.notifyPreview === current.notifyPreview) return NO_WRITE;
    // Once the step changed, every stored field matches what the step shows, so turning this device's
    // notifications on cannot revive an event the person left off.
    const settings: PersonalizeSettingWrite[] = [];
    const set = (id: LocalNotificationPreferenceId, anchor: Extract<PersonalizeSettingWrite, { value: boolean }>['anchor'], value: boolean) => {
        if (readLocalNotificationPreference(local, id) !== value) settings.push({ anchor, value });
    };
    set('permissionRequests', 'notifications.localPermissionRequests', draft.notifyNeedsYou);
    set('userActions', 'notifications.localUserActions', draft.notifyNeedsYou);
    set('ready', 'notifications.ready', draft.notifyFinished);
    set('readyPreview', 'notifications.readyPreview', draft.notifyPreview);
    set('requestPreview', 'notifications.requestPreview', draft.notifyPreview);
    // Choosing to be told about something turns this device's notifications on; choosing nothing leaves the switch alone.
    if (draft.notifyNeedsYou || draft.notifyFinished) set('enabled', 'notifications.localEnabled', true);
    return { ...NO_WRITE, settings };
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
