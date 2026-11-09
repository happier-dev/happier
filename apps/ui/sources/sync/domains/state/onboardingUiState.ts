import { z } from 'zod/mini';
import { createPersistentUiState, UiStatePersistenceError, usePersistentUiStateValue } from './persistentUiState';

const ProgressSchema = z.object({ savedSteps: z.array(z.string()), resumeAt: z.nullable(z.string()) });
const TimestampSchema = z.nullable(z.number());
const AuthHistorySchema = z.boolean();
const HomeIdsSchema = z.array(z.string().check(z.minLength(1)));
const VersionsSchema = z.record(z.string(), z.string());
const DismissalKeysSchema = z.array(z.string().check(z.minLength(1)));

export type StoredPersonalizeProgress = z.infer<typeof ProgressSchema>;
const EMPTY_PROGRESS: StoredPersonalizeProgress = { savedSteps: [], resumeAt: null };
const EMPTY_IDS: string[] = [];
const EMPTY_VERSIONS: Record<string, string> = {};

/** Visit memory and presentation history retain their existing device-wide scope. */
export const personalizeProgressState = createPersistentUiState('personalize-progress-v1',
    value => z.catch(ProgressSchema, EMPTY_PROGRESS).parse(value));
export const onboardingHistoryState = createPersistentUiState('onboarding-history-v1',
    value => z.catch(TimestampSchema, null).parse(value));
export const onboardingAuthHistoryState = createPersistentUiState('onboarding-auth-history-v1',
    value => z.catch(AuthHistorySchema, false).parse(value));
export const homesJourneyAcknowledgementsState = createPersistentUiState('homes-journey-v1',
    value => z.catch(HomeIdsSchema, EMPTY_IDS).parse(value));
export const cliVersionAcknowledgementsState = createPersistentUiState('cli-version-acknowledgements-v1',
    value => z.catch(VersionsSchema, EMPTY_VERSIONS).parse(value));
export const petActivityDismissalsState = createPersistentUiState('pet-activity-dismissals-v1',
    value => z.catch(DismissalKeysSchema, EMPTY_IDS).parse(value));

export function readPersonalizeProgress(): StoredPersonalizeProgress {
    return personalizeProgressState.read('progress') ?? EMPTY_PROGRESS;
}

export function useStoredPersonalizeProgress(): StoredPersonalizeProgress {
    return usePersistentUiStateValue(personalizeProgressState, 'progress') ?? EMPTY_PROGRESS;
}

export function useOnboardingHistoryTimestamp(key: 'brandHeroSeenAt' | 'homeWelcomeSeenAt'): number | null {
    return usePersistentUiStateValue(onboardingHistoryState, key) ?? null;
}

export function useHasCompletedAuthOnce(): boolean {
    return usePersistentUiStateValue(onboardingAuthHistoryState, 'completed') ?? false;
}

export function useHomesJourneyAcknowledgements(): readonly string[] {
    return usePersistentUiStateValue(homesJourneyAcknowledgementsState, 'acknowledged') ?? EMPTY_IDS;
}

export function useCliVersionAcknowledgements(): Readonly<Record<string, string>> {
    return usePersistentUiStateValue(cliVersionAcknowledgementsState, 'machines') ?? EMPTY_VERSIONS;
}

export function usePetActivityDismissals(): readonly string[] {
    return usePersistentUiStateValue(petActivityDismissalsState, 'tray') ?? EMPTY_IDS;
}

/** An import seed has no active Settings reader or writer after this transition. */
export function migrateProgressHealthUiState(input: unknown): unknown {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    const record = input as Record<string, unknown>;
    let retained = record;
    let refused = false;
    const move = <T>(legacyKey: string, state: ReturnType<typeof createPersistentUiState<T>>, key: string,
        parse: (value: unknown) => T) => {
        if (!Object.hasOwn(record, legacyKey)) return;
        let value: T;
        try {
            // An existing destination never authorizes discarding opaque source bytes.
            value = parse(record[legacyKey]);
        } catch (error) {
            if (!(error instanceof z.core.$ZodError)) throw error;
            refused = true;
            return;
        }
        try {
            // Explicit null, false and empty destination values are authoritative too.
            if (state.readStrict(key, parse) === undefined) state.set(key, value);
        } catch (error) {
            if (!(error instanceof UiStatePersistenceError)) throw error;
            refused = true;
            return;
        }
        if (retained === record) retained = { ...record };
        delete retained[legacyKey];
    };
    move('brandHeroSeenAt', onboardingHistoryState, 'brandHeroSeenAt', value => TimestampSchema.parse(value));
    move('hasCompletedAuthOnce', onboardingAuthHistoryState, 'completed', value => AuthHistorySchema.parse(value));
    move('acknowledgedCliVersions', cliVersionAcknowledgementsState, 'machines', value => VersionsSchema.parse(value));
    move('petsDismissedCompanionTrayItemKeys', petActivityDismissalsState, 'tray', value => DismissalKeysSchema.parse(value));
    if (refused) console.warn('[ui-state] Retained device history could not be imported; keeping its source.');
    return retained;
}
