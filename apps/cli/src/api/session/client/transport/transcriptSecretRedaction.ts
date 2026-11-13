/**
 * Exact-value redaction of host-minted secrets that an Agent can read and echo into its
 * transcript. Applied once, at the Session message writer (`buildOutboundSessionMessagePayload`),
 * before encryption or plain storage.
 *
 * Labeled mitigation for the Windows 127.0.0.1 Session MCP transport only: there the bearer
 * reaches the Agent's relay through its MCP client config, which the Agent's own process can
 * read. Unix socket Sessions give the Agent no bearer (kernel peer proof admits the Agent tree).
 * Follow-up: a Windows named-pipe Session MCP transport with peer proof, which removes the
 * Windows bearer and this registry.
 */
const registeredSecrets = new Set<string>();

export const TRANSCRIPT_SECRET_REDACTED = '[redacted]';

/** Register a live host-minted secret; the returned function unregisters it. */
export function registerTranscriptSecret(secret: string): () => void {
    registeredSecrets.add(secret);
    return () => { registeredSecrets.delete(secret); };
}

/**
 * Replaces every registered secret in the JSON content. Registered secrets are base64url, so the
 * replacement inside the serialized form is exact. Without a registered secret this is a no-op.
 */
export function redactTranscriptSecrets<T>(content: T): T {
    if (registeredSecrets.size === 0 || content === undefined) return content;
    const serialized = JSON.stringify(content);
    let redacted = serialized;
    for (const secret of registeredSecrets) redacted = redacted.split(secret).join(TRANSCRIPT_SECRET_REDACTED);
    return redacted === serialized ? content : JSON.parse(redacted) as T;
}
