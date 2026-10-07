import { resolveCanonicalModelPackId } from '@happier-dev/protocol/voice/modelPacks/catalog';

export function resolveKokoroDaemonTtsPackId(assetId: string | null | undefined): string {
    return resolveCanonicalModelPackId(assetId);
}
