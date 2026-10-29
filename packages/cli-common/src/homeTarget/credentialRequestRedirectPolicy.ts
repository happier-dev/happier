/** Credentials are admitted for the selected destination, never a redirect. */
export const CREDENTIAL_REQUEST_REDIRECT_POLICY = Object.freeze({ maxRedirects: 0, redirect: 'manual' } as const);

export class CredentialRequestRedirectError extends Error {
  readonly code = 'credential_request_redirect_refused';
  readonly retryable = false;
  readonly response: Readonly<{ status: number }>;

  constructor(readonly status: number) {
    super('Credential-bearing HTTP requests cannot follow redirects.');
    this.name = 'CredentialRequestRedirectError';
    // Never retain a response, request config, Location, headers, or transport cause.
    this.response = Object.freeze({ status });
  }
}

export function assertCredentialRequestRedirectAllowed(status: number, responseType?: string): void {
  // Conditional reads may legitimately return 304 without redirecting.
  if ((status >= 300 && status < 400 && status !== 304) || responseType === 'opaqueredirect') {
    throw new CredentialRequestRedirectError(status);
  }
}

export async function fetchWithCredentialRedirectRefusal(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Response> {
  const response = await fetchImpl(input, { ...init, redirect: CREDENTIAL_REQUEST_REDIRECT_POLICY.redirect });
  try {
    assertCredentialRequestRedirectAllowed(response.status, response.type);
  } catch (error) {
    // Refused bodies are not consumed by callers; release the transport resource.
    void response.body?.cancel().catch(() => undefined);
    throw error;
  }
  return response;
}
