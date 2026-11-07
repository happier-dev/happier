import { definePlugin } from '@happier-dev/plugin-sdk';
import type { SecretsService, SharedSecretAudience, SharedSecretSaveResult } from '@happier-dev/plugin-sdk/secrets';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';

/** Metadata only, scoped to the invocation's Account; null means coverage is unavailable. */
export async function readSavedSecretUsedBy(context: PluginAccountActionContext, ref: string) {
    return await context.services.actions.execute('secrets.usedBy', { ref }, { signal: context.signal });
}

/** Development author contract: each call still needs its own parent Action review. */
export const sharedSecretSaveAuthoring = definePlugin({
    id: 'examples.shared-secret-save',
    version: '0.1.0',
    displayName: 'Shared secret save reference',
    secrets: [{ id: 'database' }, { id: 'backup' }],
});

/** Called inside the provider Action after parsing its response, never through Action JSON. */
export async function saveGeneratedProviderSecret(
    secrets: SecretsService,
    id: 'database' | 'backup',
    generatedBytes: Uint8Array,
    reviewedAudience: SharedSecretAudience,
    signal?: AbortSignal,
): Promise<SharedSecretSaveResult> {
    return await secrets.saveShared(id, {
        label: id === 'database' ? 'Database connection' : 'Backup repository password',
        bytes: generatedBytes,
        audience: reviewedAudience,
    }, { signal });
}

/** The parent provider Action still declares and admits its ordinary authentication purpose. */
export async function sendSavedSecretToProvider(
    http: HttpService,
    secrets: SecretsService,
    url: string,
    saved: SharedSecretSaveResult,
    signal?: AbortSignal,
): ReturnType<HttpService['request']> {
    const connection = await secrets.readSavedSecret(saved.ref, { resourceRevision: saved.resourceRevision, signal });
    return await http.request({ url, method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ connection })),
    }, { signal });
}
