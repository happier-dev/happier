function decodeJwtPayloadBestEffort(token: string): unknown | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

export function extractOpenAiCodexAccountId(idToken: string | null): string | null {
  if (!idToken) return null;
  const payload = decodeJwtPayloadBestEffort(idToken);
  if (!payload || typeof payload !== "object") return null;

  const direct = (payload as { chatgpt_account_id?: unknown }).chatgpt_account_id;
  if (typeof direct === "string" && direct.trim()) return direct;

  const authClaim = (payload as { ["https://api.openai.com/auth"]?: unknown })["https://api.openai.com/auth"];
  if (authClaim && typeof authClaim === "object") {
    const nested = (authClaim as { chatgpt_account_id?: unknown; account_id?: unknown }).chatgpt_account_id
      ?? (authClaim as { account_id?: unknown }).account_id;
    if (typeof nested === "string" && nested.trim()) return nested;
  }

  const organizations = (payload as { organizations?: unknown }).organizations;
  if (Array.isArray(organizations) && organizations.length > 0) {
    const first = organizations[0];
    if (first && typeof first === "object") {
      const id = (first as { id?: unknown }).id;
      if (typeof id === "string" && id.trim()) return id;
    }
  }
  return null;
}
