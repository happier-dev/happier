import { createRandomAlphanumeric } from "@/utils/keys/createRandomAlphanumeric";

export function randomKeyNaked(length: number = 24): string {
    return createRandomAlphanumeric(length);
}
