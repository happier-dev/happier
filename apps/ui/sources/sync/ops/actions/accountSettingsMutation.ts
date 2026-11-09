import { readThemeProfileLegacyAccountScope, writeThemeProfileLegacyAccountScope } from '@/sync/domains/state/themeProfileMigrationUiState';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import type { ServerFetch } from '@/sync/http/client';
import { resolveSettingsSecretsKeySet } from '@/sync/encryption/resolveSettingsSecretsKeySet';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { runAccountSettingsMutation } from '@/sync/engine/settings/accountSettingsMutationOrder';
import { syncSettings, requireOneShotAccountSettingsMutationApplied, type AccountSettingsMutationCapture } from '@/sync/engine/settings/syncSettings';
import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';
import { loadPendingAccountSettingsState, savePendingAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { loadLocalSettings } from '@/sync/domains/state/settingsPersistence';
import { storage } from '@/sync/domains/state/storageStore';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { ThemeProfileLibrarySchema } from '@/theme/profiles/themeProfilePersistence';
import { mergeThemeProfileMigrationEdits, ThemeProfileMigrationSourceExpiredError } from '@/theme/profiles/themeProfileMigrationEdits';
import { captureLegacyThemeProfileMigration } from '@/sync/engine/settings/themeProfileMigration';


import type { ThemeProfileMigrationIntent, ThemeProfilesLocalStateV1 } from '@/theme/profiles/themeProfileTypes';


/** Source cleanup stays inside the admitted mutation's durable handoff. */
export type ThemeProfileMigrationMutation = Readonly<{
    source: ThemeProfilesLocalStateV1;
    intent: ThemeProfileMigrationIntent;
    prepareIntent: (intent: ThemeProfileMigrationIntent) => void;
    getLegacyProfileIds: () => Readonly<Record<string, string>>;
    complete: () => void;
}>;

export type RawSettingsMutationOptions = Readonly<{
    signal?: AbortSignal;
    themeProfileMigration?: ThemeProfileMigrationMutation;
    expectedProfileTransferRevision?: number | 'absent';
    expectedSettingsVersion?: number;
    rebaseOnConflict?: boolean;
    observeOutcome?: boolean;
    capture?: (transition: AccountSettingsMutationCapture) => unknown;
}>;

/** Keeps admission, the raw baseline and CAS on one captured Account transport. */
export function createAccountSettingsMutation(params: Readonly<{
    scope: AccountSettingsScope;
    credentials: AuthCredentials;
    endpointUrl: string;
    request: ServerFetch;
    signal?: AbortSignal;
    scopeSignal: AbortSignal;
    assertCurrent: () => void;
    resolveAccountEncryption: (signal?: AbortSignal) => Promise<Readonly<{ accountMode: 'plain' | 'e2ee'; encryption: Encryption | null }>>;
}>) {
    return async (mutate: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown> | Promise<Record<string, unknown>>,
        options?: RawSettingsMutationOptions) => {
        const cancellation = mergeAbortSignals([params.signal, options?.signal, params.scopeSignal]);
        const mutateInOrder = async () => {
            const assertMutationCurrent = () => {
                params.assertCurrent();
                throwIfAborted(cancellation.signal);
            };
            const mutationRequest: ServerFetch = async (path, init, requestOptions) => {
                const requestCancellation = mergeAbortSignals([cancellation.signal, init?.signal ?? undefined]);
                try {
                    assertMutationCurrent();
                    return await params.request(path, { ...init, signal: requestCancellation.signal }, requestOptions);
                } finally { requestCancellation.dispose(); }
            };
            assertMutationCurrent();
            const migration = options?.themeProfileMigration;
            const assertMigrationSourceCurrent = () => {
                if (!migration) return;
                const local = loadLocalSettings();
                if (!areAccountSettingsScopesEqual(storage.getState().settingsScope, params.scope)
                    || (readThemeProfileLegacyAccountScope() && !areAccountSettingsScopesEqual(readThemeProfileLegacyAccountScope(), params.scope))
                    || !areAccountSettingsJsonValuesEqual(local.themeProfiles, migration.source)) {
                    throw new ThemeProfileMigrationSourceExpiredError();
                }
            };
            if (migration) {
                const previous = loadPendingAccountSettingsState(params.scope);
                if (previous.themeProfileMigration?.acknowledged) {
                    const recovery = captureLegacyThemeProfileMigration(params.scope);
                    const acknowledgedState = recovery?.resolve(previous.settings.themeProfiles ?? []);
                    if (acknowledgedState) recovery?.finish(acknowledgedState);
                    throw new ThemeProfileMigrationSourceExpiredError();
                }
                assertMigrationSourceCurrent();
                if (!readThemeProfileLegacyAccountScope()) writeThemeProfileLegacyAccountScope(params.scope);
            }
            const previousMigration = migration ? loadPendingAccountSettingsState(params.scope).themeProfileMigration : null;
            const admittedIntent: ThemeProfileMigrationIntent | null = migration ? {
                ...previousMigration,
                ...migration.intent,
                edits: mergeThemeProfileMigrationEdits(previousMigration?.edits ?? [], migration.intent.edits),
                legacyProfileIds: { ...previousMigration?.legacyProfileIds, ...migration.intent.legacyProfileIds },
                ...(previousMigration?.representedLegacyProfileIds || migration.intent.representedLegacyProfileIds
                    ? { representedLegacyProfileIds: { ...previousMigration?.representedLegacyProfileIds, ...migration.intent.representedLegacyProfileIds } } : {}),
                ...(migration.intent.replaceLibrary || previousMigration?.replaceLibrary ? { replaceLibrary: true } : {}),
            } : null;
            if (admittedIntent) migration?.prepareIntent(admittedIntent);
            const staged: { current: Readonly<{ intent: ThemeProfileMigrationIntent; profiles: ReturnType<typeof ThemeProfileLibrarySchema.parse> }> | null } = { current: null };
            const { accountMode, encryption } = await params.resolveAccountEncryption(cancellation.signal);
            assertMutationCurrent();
            const settingsSecretsKeys = await resolveSettingsSecretsKeySet({ credentials: params.credentials, scope: params.scope });
            assertMutationCurrent();
            const baseline = await readAccountSettingsBaseline({ request: mutationRequest, credentials: params.credentials, encryption, accountMode });
            assertMutationCurrent();
            const result = await syncSettings({ credentials: params.credentials, encryption, signal: cancellation.signal, settingsScope: params.scope,
                settingsSecretsKey: settingsSecretsKeys?.writeKey ?? null,
                settingsSecretsReadKeys: settingsSecretsKeys?.readKeys ?? [],
                requestContext: { scope: params.scope, endpointUrl: params.endpointUrl, request: mutationRequest,
                    admittedBaseline: { accountMode, value: baseline } },
                pendingSettings: {}, clearPendingSettings: () => {},
                oneShotServerSettingsMutation: { expectedSettingsVersion: options?.expectedSettingsVersion ?? baseline.version,
                    rebaseOnConflict: options?.rebaseOnConflict ?? true,
                    ...((migration || options?.capture) ? { capture: (transition: AccountSettingsMutationCapture) => {
                        if (migration) {
                            const pending = loadPendingAccountSettingsState(params.scope);
                            const intent: ThemeProfileMigrationIntent = {
                                ...(admittedIntent ?? migration.intent),
                                legacyProfileIds: migration.getLegacyProfileIds(),
                                ...(admittedIntent?.attemptedLegacyProfileIds
                                    ? { attemptedLegacyProfileIds: migration.getLegacyProfileIds() } : {}),
                            };
                            const profiles = ThemeProfileLibrarySchema.parse(transition.applied.themeProfiles ?? []);
                            savePendingAccountSettings(params.scope, { ...pending.settings, themeProfiles: profiles }, intent);
                            staged.current = { intent, profiles };
                        }
                        return options?.capture?.(transition);
                    } } : {}),
                    ...(options?.expectedProfileTransferRevision === undefined ? {} : { expectedProfileTransferRevision: options.expectedProfileTransferRevision }),
                    mutate: async raw => {
                        assertMutationCurrent();
                        assertMigrationSourceCurrent();
                        const settings = await mutate(raw);
                        assertMutationCurrent();
                        assertMigrationSourceCurrent();
                        return { settings, value: undefined };
                    } },
            });
            // A committed receipt survives retirement; syncSettings owns scope-safe publication.
            if (result?.status !== 'applied') params.assertCurrent();
            if (!result) throw new Error('Account Settings mutation did not run');
            if (result.status === 'invalid') return requireOneShotAccountSettingsMutationApplied(result);
            const submitted = staged.current;
            if (result.status === 'applied' && migration && submitted) {
                // syncSettings has published the acknowledged Account projection. Keep the
                // existing pending record until device-local source cleanup also succeeds.
                const pending = loadPendingAccountSettingsState(params.scope);
                const acknowledged: ThemeProfileMigrationIntent = { ...submitted.intent, acknowledged: true };
                savePendingAccountSettings(params.scope, { ...pending.settings, themeProfiles: submitted.profiles }, acknowledged);
                assertMutationCurrent();
                migration.complete();
                const latest = loadPendingAccountSettingsState(params.scope);
                if (areAccountSettingsJsonValuesEqual(latest.themeProfileMigration, acknowledged)) {
                    const remaining = { ...latest.settings };
                    if (areAccountSettingsJsonValuesEqual(remaining.themeProfiles, submitted.profiles)) delete remaining.themeProfiles;
                    savePendingAccountSettings(params.scope, remaining, null);
                }
            }
            if (!options?.observeOutcome) requireOneShotAccountSettingsMutationApplied(result);
            return result;
        };
        try {
            return await runAccountSettingsMutation(params.scope, mutateInOrder, cancellation.signal);
        } catch (error) {
            params.assertCurrent();
            throw error;
        } finally { cancellation.dispose(); }
    };
}
