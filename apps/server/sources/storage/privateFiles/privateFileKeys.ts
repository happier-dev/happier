import { posix } from "node:path";

export function normalizePrivateFileKey(key: string): string {
    if (key.includes("\0")) {
        throw new Error("Invalid private file key");
    }

    const raw = key.replace(/\\/g, "/").trim();
    if (!raw || raw.startsWith("/")) {
        throw new Error("Invalid private file key");
    }

    const normalized = posix.normalize(raw).replace(/^\/+/, "");
    const parts = normalized.split("/").filter(Boolean);
    if (
        parts.length === 0 ||
        normalized.startsWith("../") ||
        normalized === ".." ||
        normalized.includes(":") ||
        parts.some((part) => part === "..")
    ) {
        throw new Error("Invalid private file key");
    }

    return parts.join("/");
}
