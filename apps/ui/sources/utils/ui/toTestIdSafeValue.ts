export function toTestIdSafeValue(value: string): string {
    return String(value ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '_');
}
