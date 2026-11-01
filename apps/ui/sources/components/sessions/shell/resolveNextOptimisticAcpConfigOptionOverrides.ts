type ConfigOverrideValue = Readonly<{
    updatedAt?: number | null;
    value?: string | number | boolean | null;
}>;

type ConfigOverrides = Readonly<{
    v?: number | null;
    updatedAt?: number | null;
    overrides?: Readonly<Record<string, ConfigOverrideValue>> | null;
}> | null | undefined;

function areOverrideMapsEqual(
    current: ConfigOverrides,
    incoming: ConfigOverrides,
): boolean {
    if (current === incoming) return true;
    if (!current || !incoming) return current === incoming;
    if ((current.v ?? null) !== (incoming.v ?? null)) return false;
    if ((current.updatedAt ?? null) !== (incoming.updatedAt ?? null)) return false;

    const currentOverrides = current.overrides ?? {};
    const incomingOverrides = incoming.overrides ?? {};
    const currentKeys = Object.keys(currentOverrides);
    const incomingKeys = Object.keys(incomingOverrides);

    if (currentKeys.length !== incomingKeys.length) return false;

    for (const key of currentKeys) {
        const currentValue = currentOverrides[key];
        const incomingValue = incomingOverrides[key];
        if (!incomingValue) return false;
        if ((currentValue?.updatedAt ?? null) !== (incomingValue.updatedAt ?? null)) return false;
        if ((currentValue?.value ?? null) !== (incomingValue.value ?? null)) return false;
    }

    return true;
}

export function resolveNextOptimisticAcpConfigOptionOverrides(params: Readonly<{
    current: ConfigOverrides;
    incoming: ConfigOverrides;
    sessionChanged: boolean;
    rejected?: Readonly<{ configId: string; updatedAt: number }>;
}>): ConfigOverrides {
    if (params.sessionChanged) {
        return params.incoming;
    }

    if (params.rejected) {
        const { configId, updatedAt } = params.rejected;
        if (!params.current || params.current.overrides?.[configId]?.updatedAt !== updatedAt) return params.current;
        const overrides = { ...params.current.overrides };
        const previous = params.incoming?.overrides?.[configId];
        if (previous) overrides[configId] = previous;
        else delete overrides[configId];
        return {
            ...params.current,
            updatedAt: Object.values(overrides).reduce((latest, entry) => Math.max(latest, entry.updatedAt ?? 0), params.incoming?.updatedAt ?? 0),
            overrides,
        };
    }

    const currentUpdatedAt = params.current?.updatedAt ?? null;
    const incomingUpdatedAt = params.incoming?.updatedAt ?? null;

    if (currentUpdatedAt == null) {
        return params.incoming;
    }
    if (incomingUpdatedAt == null) {
        return params.current;
    }
    if (incomingUpdatedAt > currentUpdatedAt) {
        return params.incoming;
    }
    if (incomingUpdatedAt < currentUpdatedAt) {
        return params.current;
    }

    return areOverrideMapsEqual(params.current, params.incoming)
        ? params.current
        : params.incoming;
}
