import { resolveCanonicalModelPackId } from '@happier-dev/protocol';

export function resolveKokoroDaemonTtsPackId(assetId: string | null | undefined): string {
    return resolveCanonicalModelPackId(assetId);
}
