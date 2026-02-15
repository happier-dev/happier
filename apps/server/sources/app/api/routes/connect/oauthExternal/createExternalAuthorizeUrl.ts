import { randomBytes } from "node:crypto";

import { auth } from "@/app/auth/auth";
import { isOAuthStateUnavailableError } from "@/app/auth/oauthStateErrors";
import { generatePkceVerifier, pkceChallengeS256 } from "@/app/oauth/pkce";
import type { OAuthFlowProvider } from "@/app/oauth/providers/registry";
import { db } from "@/storage/db";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { resolveOauthStateAttemptTtlMsFromEnv } from "./oauthExternalConfig";

type ExternalAuthorizeFlowParams =
    | Readonly<{
          flow: "auth";
          providerId: string;
          provider: OAuthFlowProvider;
          env: NodeJS.ProcessEnv;
          publicKeyHex: string;
      }>
    | Readonly<{
          flow: "connect";
          providerId: string;
          provider: OAuthFlowProvider;
          env: NodeJS.ProcessEnv;
          userId: string;
      }>;

export async function createExternalAuthorizeUrl(params: ExternalAuthorizeFlowParams): Promise<string | null> {
    const ttlMs = resolveOauthStateAttemptTtlMsFromEnv(params.env);
    const pkceCodeVerifier = generatePkceVerifier(64);
    const codeChallenge = pkceChallengeS256(pkceCodeVerifier);
    const nonce = randomBytes(32).toString("base64url");

    let sid = "";
    for (let i = 0; i < 3; i++) {
        sid = randomKeyNaked(24);
        try {
            await db.repeatKey.create({
                data: {
                    key: `oauth_state_${sid}`,
                    value: JSON.stringify({ provider: params.providerId, pkceCodeVerifier, nonce }),
                    expiresAt: new Date(Date.now() + ttlMs),
                },
            });
            break;
        } catch {
            sid = "";
        }
    }
    if (!sid) return null;
    const repeatKeyId = `oauth_state_${sid}`;

    let state: string;
    try {
        state = params.flow === "auth"
            ? await auth.createOauthStateToken({
                  flow: "auth",
                  provider: params.providerId,
                  sid,
                  publicKey: params.publicKeyHex,
              })
            : await auth.createOauthStateToken({
                  flow: "connect",
                  provider: params.providerId,
                  sid,
                  userId: params.userId,
              });
    } catch (error) {
        if (isOAuthStateUnavailableError(error)) {
            await db.repeatKey.delete({ where: { key: repeatKeyId } }).catch(() => undefined);
            return null;
        }
        throw error;
    }

    const scope = params.provider.resolveScope({ env: params.env, flow: params.flow });
    return await params.provider.resolveAuthorizeUrl({
        env: params.env,
        state,
        scope,
        codeChallenge,
        codeChallengeMethod: "S256",
        nonce,
    });
}
