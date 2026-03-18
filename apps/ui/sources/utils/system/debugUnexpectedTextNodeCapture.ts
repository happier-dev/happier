function getTypeName(type: unknown): string {
    if (typeof type === 'function') {
        return String((type as any).displayName ?? (type as any).name ?? 'unknown');
    }
    if (typeof type === 'string') return type;
    if (type && typeof type === 'object') {
        const candidate = type as any;
        return String(
            candidate.displayName
            ?? candidate.name
            ?? candidate.render?.displayName
            ?? candidate.render?.name
            ?? 'unknown',
        );
    }
    return 'unknown';
}

function isViewLikeType(type: unknown): boolean {
    const typeName = getTypeName(type);
    return typeName === 'View';
}

function formatPrimitiveSample(value: string | number): string {
    const text = String(value);
    const codePoints = Array.from(text)
        .map((char) => `U+${char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0') ?? '????'}`)
        .join(' ');
    return `${JSON.stringify(text)} (${codePoints})`;
}

export function getCurrentReactOwnerHint(reactValue: unknown) {
    try {
        const internals = (reactValue as any)?.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
        const owner = internals?.ReactCurrentOwner?.current;
        const ownerType = owner?.type;
        const ownerName = getTypeName(ownerType) || null;
        const source = owner?._debugSource || owner?._debugOwner?._debugSource || null;
        return ownerName ? { ownerName, source } : source ? { source } : null;
    } catch {
        return null;
    }
}

export function getUnexpectedPrimitiveViewChildInfo(params: Readonly<{
    type: unknown;
    props: Readonly<Record<string, unknown> | null | undefined>;
    flatChildren: readonly unknown[];
}>) {
    if (!isViewLikeType(params.type)) return null;

    const primitiveChildren = params.flatChildren.filter((child) => {
        if (typeof child === 'number') return true;
        return typeof child === 'string' && child.length > 0;
    }) as Array<string | number>;

    if (primitiveChildren.length === 0) return null;

    const sample = primitiveChildren[0];
    const typeName = getTypeName(params.type);
    const testID = typeof params.props?.testID === 'string' ? params.props.testID : null;
    const accessibilityLabel =
        typeof params.props?.accessibilityLabel === 'string' ? params.props.accessibilityLabel : null;

    return {
        typeName,
        isViewLike: true,
        primitiveChildCount: primitiveChildren.length,
        primitiveSamples: primitiveChildren.slice(0, 3).map((value) => formatPrimitiveSample(value)),
        signature: `${typeName}|${testID ?? ''}|${accessibilityLabel ?? ''}|${primitiveChildren.map((value) => String(value)).join('|')}`,
        testID,
        accessibilityLabel,
    };
}
