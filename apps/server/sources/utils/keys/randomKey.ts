import { createRandomAlphanumeric } from "@/utils/keys/createRandomAlphanumeric";

export function randomKey(prefix: string, length: number = 24): string {
    return `${prefix}_${createRandomAlphanumeric(length)}`;
}
