export function containsProviderRegisteredSecret(
  input: string,
  registeredSecretValues: readonly string[],
): boolean {
  return containsProviderRegisteredSensitiveValue(input, registeredSecretValues);
}

/**
 * Detects registered sensitive values in untrusted Provider output, including
 * their URL-percent-encoded representation. This is the shared egress check
 * for response fields and redirect targets; callers must reject a match
 * rather than attempting to redact and continue the request.
 */
export function containsProviderRegisteredSensitiveValue(
  input: string,
  registeredValues: readonly string[],
): boolean {
  const lowerInput = input.toLowerCase();
  return registeredValues.some((value) => {
    if (value.length === 0) return false;
    if (input.includes(value)) return true;
    const encoded = encodeURIComponent(value);
    if (encoded !== value && lowerInput.includes(encoded.toLowerCase())) return true;
    const formEncoded = encoded.replaceAll('%20', '+');
    return formEncoded !== encoded && lowerInput.includes(formEncoded.toLowerCase());
  });
}
