import {
    isOriginAllowedByApiTokenGrantV1,
    type ApiTokenGrantV1,
} from "@happier-dev/protocol/auth/apiTokenGrant";
import type { ServerConfigEnv } from "@happier-dev/protocol/serverConfig/serverConfigCodec";

import { resolveEffectiveWebappUrl } from "@/app/serverUrls/effectiveServerUrls";

/**
 * HTTP and socket admission share the grant plus the configured Happier origin. The web app is a
 * live Home setting, so it is read from the Home overlay (as Reach and link builders read it), and
 * only when the grant alone does not admit the origin.
 */
export async function isApiTokenRequestOriginAllowed(
    grant: ApiTokenGrantV1,
    origin: string,
    readHomeEnv: () => Promise<ServerConfigEnv>,
): Promise<boolean> {
    if (isOriginAllowedByApiTokenGrantV1(grant, origin)) return true;
    const webappUrl = resolveEffectiveWebappUrl(await readHomeEnv());
    return webappUrl !== undefined && new URL(webappUrl).origin === origin;
}
