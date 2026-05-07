import { hashStringToPositiveInt } from '@/components/ui/avatar/avatarHash';

export const AVATAR_GENERATION_CACHE_VERSION = 15;

export function createGeneratedAvatarCacheKey(parts: readonly string[]): string {
    const payload = parts.join('\u0000');
    return `avatar-generation-v${AVATAR_GENERATION_CACHE_VERSION}:${hashStringToPositiveInt(payload).toString(36)}`;
}
