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

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function extractOpenAiCodexAccountId(idToken: string | null): string | null {
  if (!idToken) return null;
  const payload = decodeJwtPayloadBestEffort(idToken);
  if (!payload || typeof payload !== "object") return null;

  const direct = (payload as { chatgpt_account_id?: unknown }).chatgpt_account_id;
  const directText = readString(direct);
  if (directText) return directText;

  const authClaim = (payload as { ["https://api.openai.com/auth"]?: unknown })["https://api.openai.com/auth"];
  const authRecord = readRecord(authClaim);
  if (authRecord) {
    const nested = readString(authRecord.chatgpt_account_id) ?? readString(authRecord.account_id);
    if (nested) return nested;
  }

  const organizations = (payload as { organizations?: unknown }).organizations;
  if (Array.isArray(organizations) && organizations.length > 0) {
    const first = organizations[0];
    if (first && typeof first === "object") {
      const id = readString((first as { id?: unknown }).id);
      if (id) return id;
    }
  }
  return null;
}

export function extractOpenAiCodexEmail(idToken: string | null): string | null {
  if (!idToken) return null;
  const payload = decodeJwtPayloadBestEffort(idToken);
  const payloadRecord = readRecord(payload);
  if (!payloadRecord) return null;

  const direct = readString(payloadRecord.email);
  if (direct) return direct;

  const profileClaim = readRecord(payloadRecord["https://api.openai.com/profile"]);
  return readString(profileClaim?.email)
    ?? readString(profileClaim?.profile_email)
    ?? readString(profileClaim?.account_email)
    ?? null;
}
