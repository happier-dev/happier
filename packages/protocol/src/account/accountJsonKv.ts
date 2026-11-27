/** Public KV namespaces whose content follows the persisted Account mode. */
export const ACCOUNT_JSON_KV_PREFIXES = { todo: 'todo.', workspace: 'workspace:' } as const;
export type AccountJsonKvNamespace = keyof typeof ACCOUNT_JSON_KV_PREFIXES;

/** Maximum mutations in one atomic request to the public Account KV route. */
export const ACCOUNT_KV_MUTATION_BATCH_MAX = 100;

export function classifyAccountJsonKvKey(key: string): AccountJsonKvNamespace | null {
    for (const namespace of Object.keys(ACCOUNT_JSON_KV_PREFIXES) as AccountJsonKvNamespace[]) {
        const prefix = ACCOUNT_JSON_KV_PREFIXES[namespace];
        if (key.startsWith(prefix) && key.length > prefix.length) return namespace;
    }
    return null;
}
