import { isIP } from "node:net";

import { isPrivateNetworkAddress, parseIpAddress } from "@/app/net/addressPolicy";
import { IROH_REQUEST_IP } from './requestIngress';

export type RequestIpClassification = "public" | "private" | "unknown";

/**
 * Classifies the network an inbound request arrived from.
 *
 * Preserve the released classifier's accepted spellings and textual IPv6 union.
 * The stricter outbound policy deliberately canonicalizes more encodings, but an
 * inbound compatibility refactor must not silently change proxy-origin behavior.
 */
export function classifyRequestIp(rawIp: unknown): RequestIpClassification {
    const raw = typeof rawIp === "string" ? rawIp.trim() : "";
    if (raw === IROH_REQUEST_IP) return 'public';
    if (!raw) return "unknown";

    const dottedMapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1]?.trim();
    if (dottedMapped) {
        const mapped = parseIpAddress(dottedMapped);
        if (!mapped || mapped.version !== 4) return "unknown";
        return isPrivateNetworkAddress(mapped) ? "private" : "public";
    }

    const version = isIP(raw);
    if (version === 4) {
        const facts = parseIpAddress(raw);
        if (!facts) return "unknown";
        return isPrivateNetworkAddress(facts) ? "private" : "public";
    }
    if (version === 6) {
        const value = raw.toLowerCase();
        if (value === "::1" || value === "::") return "private";
        if (value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) {
            return "private";
        }
        if (value.startsWith("fc") || value.startsWith("fd")) return "private";
        return "public";
    }

    return "unknown";
}
