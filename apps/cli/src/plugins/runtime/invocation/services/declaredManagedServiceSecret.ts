import type { ResolveDeclaredManagedServiceSecret } from './managedServicesOwner';

/**
 * Resolves the user-recorded credential that authenticates an attached managed
 * service. The caller's exact admitted generation supplies the operation
 * scoped port, which is already bound to one manifest declaration and the
 * canonical secret custody router.
 *
 * This adapter deliberately has no paths, declaration inventory, key material,
 * or secret-store cache. Account custody and undeclared ids are unavailable;
 * the resolved daemon value reaches only the managed-services owner, which
 * renders and redacts it without exposing it to plugin code or diagnostics.
 */
export function createDeclaredManagedServiceSecretResolver(): ResolveDeclaredManagedServiceSecret {
    return async ({ scope, secretId, canonicalOrigin, signal }) => {
        signal?.throwIfAborted();
        if (!scope.isGenerationCurrent()) return null;
        const readSecret = scope.declaredSecretReadPort;
        if (!readSecret) return null;
        const result = await readSecret({
            secretId,
            canonicalOrigin,
            ...(signal ? { signal } : {}),
        });
        signal?.throwIfAborted();
        if (!scope.isGenerationCurrent()) return null;
        return result;
    };
}
