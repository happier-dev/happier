import * as crypto from "crypto";

export function createRandomAlphanumeric(length: number): string {
    while (true) {
        const randomBytesBuffer = crypto.randomBytes(length * 2);
        const normalized = randomBytesBuffer.toString("base64").replace(/[^a-zA-Z0-9]/g, "");
        if (normalized.length < length) {
            continue;
        }
        return normalized.slice(0, length);
    }
}
