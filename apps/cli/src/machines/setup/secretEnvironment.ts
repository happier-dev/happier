import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { listSecretReferenceOverlayV1BindingNames, readSecretReferenceOverlayV1Reference } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveRequesterSavedSecretActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { StoredCredentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { refreshSavedSecretCatalogForOperation } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import type { ApplyMachineSetupInput } from './applyMachineSetup';

export type MachineSetupSecretCustody = Readonly<{
    credentials: StoredCredentials;
    serverHttpBaseUrl: string;
    authorization?: ExternalActionExecutionAuthorizationV1;
    operationContext?: SavedSecretOperationContextV1;
}>;

/** Selected script references use the incumbent Account materializer. A signed
 * requester borrows its admitted custody and never inherits controller secrets. */
export async function prepareMachineSetupSecretEnvironment(input: MachineSetupSecretCustody & Readonly<{
    sources: readonly MachineSetupV1[];
    signal: AbortSignal;
    isCurrent(): Promise<boolean>;
}>): Promise<Readonly<{ environment?: ApplyMachineSetupInput['secretEnvironment']; dispose(): void }>> {
    const scriptSources = input.sources.filter(setup => setup.scripts?.some(script => script.body));
    if (!scriptSources.some(setup => setup.secretRefs)) return { dispose() {} };
    const custody = resolveRequesterSavedSecretActionCustody(input);
    let context = custody.operation;
    let ownedContext: SavedSecretOperationContextV1 | undefined;
    try {
        if (!context) {
            const snapshot = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => bootstrapAccountSettingsContext({
                credentials: custody.credentials, mode: 'blocking', refresh: 'force', publication: 'invocation', honorAccountSettingsModeEnv: false,
                shouldCommit: () => !input.signal.aborted }));
            if (snapshot.source !== 'network' || input.signal.aborted) {
                throw Object.assign(new Error('saved_secret_unavailable'), { code: 'saved_secret_unavailable' });
            }
            context = ownedContext = createInvocationSavedSecretOperationContextV1({ credentials: custody.credentials, snapshot,
                serverHttpBaseUrl: input.serverHttpBaseUrl, isCurrent: input.isCurrent });
        }
        const references = scriptSources.flatMap(setup => setup.secretRefs
            ? listSecretReferenceOverlayV1BindingNames(setup.secretRefs).map(name => readSecretReferenceOverlayV1Reference(setup.secretRefs!, name)!) : []);
        const secrets = await refreshSavedSecretCatalogForOperation({ expectedScopeKey: resolveAccountSettingsScopeKeyForToken(custody.credentials.token),
            references, operationContext: context, signal: input.signal });
        input.signal.throwIfAborted();
        return { environment: { accountSettings: secrets.settings, settingsSecretsReadKeys: secrets.settingsSecretsReadKeys,
            savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(secrets, { operationContext: context }),
            savedSecretResources: secrets.savedSecretResources }, dispose: () => ownedContext?.withdrawCatalog() };
    } catch (error) {
        ownedContext?.withdrawCatalog();
        throw error;
    }
}
