/** Validate an opaque identifier for presence without changing its bytes. */
export function readNonBlankOpaqueIdentifier(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
