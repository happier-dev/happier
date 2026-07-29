function headerName(value: string): string {
    return value.trim().toLowerCase();
}

export function isPreviewControlledForwardingHeader(name: string): boolean {
    const normalized = headerName(name);
    return normalized === "forwarded"
        || normalized === "x-real-ip"
        || normalized === "via"
        || normalized.startsWith("x-forwarded-");
}
