import { prepareEnvironmentSecretBindingsV1 } from '@happier-dev/deployments';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import {
    type EnvironmentSecretBindingV1, type MachineSecretGrantV1,
} from '@happier-dev/deployment-protocol';
import type { SavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
import { LaunchSecretReferenceOverlayError, materializeSavedSecretReferenceBinding } from '@/settings/secrets/secretReferenceOverlay';
import { sealMachineSecretGrant } from './machineSecretGrant';

export type EnvironmentOperationalSecretBinding = Exclude<EnvironmentSecretBindingV1, { purpose: 'variable' }>;
export type EnvironmentSecretInstallation = Readonly<{ machineId: string; installationId: string; publicKey: Uint8Array }>;
type OperationalDestination = Readonly<{
    binding: EnvironmentOperationalSecretBinding;
    /** Produced by the destination/Domain/data owner under the same admitted mutation. */
    installations: readonly EnvironmentSecretInstallation[];
}>;
type Destinations = Readonly<{
    runtimeInstallations: readonly EnvironmentSecretInstallation[];
    buildInstallation?: EnvironmentSecretInstallation;
    operationalDestinations?: readonly OperationalDestination[];
    domainDestinations?: Parameters<typeof prepareEnvironmentSecretBindingsV1>[0]['domainDestinations'];
}>;

export async function prepareEnvironmentSecretBindings(input: Destinations & Readonly<{
    environmentId: string;
    bindings: readonly EnvironmentSecretBindingV1[];
    previousBindings: readonly EnvironmentSecretBindingV1[];
    /** Placement mutations supply the prior admitted assignment for exact retained-use comparison. */
    previousDestinations?: Destinations;
    existingGrants: readonly MachineSecretGrantV1[];
    materializer?: SavedSecretMaterializerV1 | (() => Promise<SavedSecretMaterializerV1>);
    /** Canonical admission rechecks principal, exact purpose owners, resources, installations and approval. */
    assertCurrent: () => Promise<void>;
}>) {

    let materializer = typeof input.materializer === 'function' ? undefined : input.materializer;
    try { return await prepareEnvironmentSecretBindingsV1({ ...input, sealGrant: sealMachineSecretGrant,
        ...(input.materializer ? { resolveSecret: async (binding) => {
            if (!materializer && typeof input.materializer === 'function') materializer = await input.materializer();
            await input.assertCurrent();
            if (!materializer) throw new PluginError({ code: 'client_required', message: 'Environment binding custody is unavailable' });
            try {
                const value = materializeSavedSecretReferenceBinding({ requirementName: binding.ref,
                    binding: { ref: binding.ref, revision: binding.resourceRevision }, materializer, exactReference: true });
                if (value == null) throw new PluginError({ code: 'secret_missing', message: 'Environment binding custody is unavailable' });
                return value;
            } catch (error) {
                if (error instanceof LaunchSecretReferenceOverlayError) throw new PluginError({ code: 'secret_missing', message: 'Environment binding custody is unavailable' });
                throw error;
            }
        } } : {}),
    }); } catch (error) {
        if (error instanceof Error && 'code' in error && (error.code === 'secret_missing'
            || error.code === 'client_required' || error.code === 'personal_secret_requires_promotion')) {
            throw new PluginError({ code: error.code, message: 'Environment binding custody is unavailable' });
        }
        throw error;
    }
}
