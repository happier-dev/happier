import type { PublicSessionShare } from "./sharingTypes";

export type PublicShareTokenCache = Readonly<{
  get: () => string | null;
  set: (token: string | null) => void;
}>;

export type CreatePublicShareApi<CredentialsT> = Readonly<{
  createPublicShare: (
    credentials: CredentialsT,
    sessionId: string,
    request: Readonly<{
      token: string;
      encryptedDataKey?: string;
      expiresAt?: number;
      maxUses?: number;
      isConsentRequired: boolean;
    }>,
  ) => Promise<PublicSessionShare>;
}>;

export async function createPublicShareWithClientToken<CredentialsT>(params: Readonly<{
  credentials: CredentialsT;
  sessionId: string;
  sessionEncryptionMode: "e2ee" | "plain";
  expiresInDays?: number;
  maxUses?: number;
  isConsentRequired: boolean;
  tokenCache: PublicShareTokenCache;
  generateTokenHex: () => string;
  getSessionDataKey?: (sessionId: string) => Uint8Array | null;
  encryptDataKeyForPublicShare?: (dataKey: Uint8Array, token: string) => Promise<string>;
  api: CreatePublicShareApi<CredentialsT>;
}>): Promise<PublicSessionShare> {
  try {
    const token = params.generateTokenHex().trim();
    if (!token) {
      throw new Error("createPublicShareWithClientToken: token is required");
    }
    const expiresAt = params.expiresInDays ? Date.now() + params.expiresInDays * 24 * 60 * 60 * 1000 : undefined;

    const encryptedDataKey = await (async () => {
      if (params.sessionEncryptionMode !== "e2ee") return undefined;
      const dataKey = params.getSessionDataKey?.(params.sessionId) ?? null;
      if (!dataKey) {
        throw new Error("Session data key is required for e2ee public shares");
      }
      if (!params.encryptDataKeyForPublicShare) {
        throw new Error("encryptDataKeyForPublicShare is required for e2ee public shares");
      }
      return await params.encryptDataKeyForPublicShare(dataKey, token);
    })();

    const created = await params.api.createPublicShare(params.credentials, params.sessionId, {
      token,
      ...(encryptedDataKey ? { encryptedDataKey } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(params.maxUses !== undefined ? { maxUses: params.maxUses } : {}),
      isConsentRequired: params.isConsentRequired,
    });

    const committed = { ...created, token };
    params.tokenCache.set(token);
    return committed;
  } catch (error) {
    params.tokenCache.set(null);
    throw error;
  }
}
