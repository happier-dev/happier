/**
 * Canonical locale-independent order for identifiers and keys (UTF-16 code units).
 * Use `localeCompare` only for text a person reads: Hermes on Android answers each
 * collation through a JNI Collator copy, so id sorts must not pay for it.
 */
export function compareCodeUnits(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
