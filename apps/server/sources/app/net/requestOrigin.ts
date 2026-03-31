import { isIP } from "node:net";

export type RequestIpClassification = "public" | "private" | "unknown";

function parseIpv4(raw: string): number[] | null {
    const parts = raw.split(".");
    if (parts.length !== 4) return null;
    const octets = parts.map((part) => {
        if (!/^\d{1,3}$/.test(part)) return Number.NaN;
        return Number(part);
    });
    if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return octets as number[];
}

function isPrivateIpv4(octets: readonly number[]): boolean {
    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && typeof b === "number" && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && typeof b === "number" && b >= 64 && b <= 127) return true;
    return false;
}

function isPrivateIpv6(raw: string): boolean {
    const value = raw.toLowerCase();
    if (!value) return false;
    if (value === "::1") return true;
    if (value === "::") return true;
    if (value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) return true;
    if (value.startsWith("fc") || value.startsWith("fd")) return true;
    return false;
}

function extractMappedIpv4(raw: string): string | null {
    const value = raw.toLowerCase().trim();
    const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    return mapped?.[1]?.trim() ?? null;
}

export function classifyRequestIp(rawIp: unknown): RequestIpClassification {
    const raw = typeof rawIp === "string" ? rawIp.trim() : "";
    if (!raw) return "unknown";

    const mappedIpv4 = extractMappedIpv4(raw);
    if (mappedIpv4) {
        const octets = parseIpv4(mappedIpv4);
        if (!octets) return "unknown";
        return isPrivateIpv4(octets) ? "private" : "public";
    }

    const version = isIP(raw);
    if (version === 4) {
        const octets = parseIpv4(raw);
        if (!octets) return "unknown";
        return isPrivateIpv4(octets) ? "private" : "public";
    }
    if (version === 6) {
        return isPrivateIpv6(raw) ? "private" : "public";
    }

    return "unknown";
}
