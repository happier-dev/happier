import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import type { ServerFetch } from '@/sync/http/client';
import { resolveSettingsSecretsKeySet } from '@/sync/encryption/resolveSettingsSecretsKeySet';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { runAccountSettingsMutation } from '@/sync/engine/settings/accountSettingsMutationOrder';
import { syncSettings, requireOneShotAccountSettingsMutationApplied, type AccountSettingsMutationCapture } from '@/sync/engine/settings/syncSettings';
import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';


export type RawSettingsMutationOptions = Readonly<{
    signal?: AbortSignal;
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
                    ...(options?.capture ? { capture: options.capture } : {}),
                    ...(options?.expectedProfileTransferRevision === undefined ? {} : { expectedProfileTransferRevision: options.expectedProfileTransferRevision }),
                    mutate: async raw => {
                        assertMutationCurrent();
                        const settings = await mutate(raw);
                        assertMutationCurrent();
                        return { settings, value: undefined };
                    } },
            });
            // A committed receipt survives retirement; syncSettings owns scope-safe publication.
            if (result?.status !== 'applied') params.assertCurrent();
            if (!result) throw new Error('Account Settings mutation did not run');
            if (result.status === 'invalid') return requireOneShotAccountSettingsMutationApplied(result);
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
