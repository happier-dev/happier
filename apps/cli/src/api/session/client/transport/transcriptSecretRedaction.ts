/**
 * Exact-value redaction of host-minted secrets that an Agent can read and echo into its
 * transcript. Applied once at each Session writer of Agent-authored content, before encryption or
 * plain storage: the message writer (`buildOutboundSessionMessagePayload`) and the Agent-state commit
 * (`ApiSessionClient.updateAgentState`, which carries permission request arguments).
 *
 * Covers Session MCP registration bearers, plugin-hosted loopback MCP servers and the session hook server. Their
 * secrets reach the Agent only through its runner-written private config (MCP client config,
 * bridge config, hook secret files), which the Agent's own process can read. Session MCP relays
 * use their registration bearer to distinguish catalogs sharing one endpoint; Unix shell clients
 * can also use kernel peer proof without a bearer.
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
