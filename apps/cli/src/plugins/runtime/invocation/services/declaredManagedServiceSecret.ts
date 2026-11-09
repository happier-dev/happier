import type { ResolveDeclaredManagedServiceSecret } from './managedServicesOwner';

/**
 * Resolves the user-recorded credential that authenticates an attached managed
 * service. The caller's exact admitted occurrenceId supplies the operation
 * scoped port, which uses manifest data-custody metadata and the canonical
 * secret custody router.
 *
 * This adapter deliberately has no paths, declaration inventory, key material,
 * or secret-store cache. Account-custodied slots are unavailable;
 * the resolved daemon value reaches only the managed-services owner, which
 * renders and redacts it without exposing it to plugin code or diagnostics.
 */
export function createDeclaredManagedServiceSecretResolver(): ResolveDeclaredManagedServiceSecret {
    return async ({ scope, secretId, canonicalOrigin, signal }) => {
        signal?.throwIfAborted();
        if (!scope.isOccurrenceCurrent()) return null;
        const readSecret = scope.declaredSecretReadPort;
        if (!readSecret) return null;
        const result = await readSecret({
            secretId,
            canonicalOrigin,
            ...(signal ? { signal } : {}),
        });
        signal?.throwIfAborted();
        if (!scope.isOccurrenceCurrent()) return null;
        return result;
    };
}
