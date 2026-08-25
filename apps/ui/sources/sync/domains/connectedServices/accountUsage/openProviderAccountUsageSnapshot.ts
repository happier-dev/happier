import {
    ProviderAccountUsageSnapshotV1Schema,
    openProviderAccountUsageSnapshotCiphertext,
    type ProviderAccountUsageSnapshotV1,
    type SealedProviderAccountUsageSnapshotV1,
    type StoredJsonContentEnvelope,
} from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '../resolveAccountScopedCryptoMaterialFromCredentials';

export function openProviderAccountUsageSnapshot(
    credentials: AuthCredentials,
    content:
        | SealedProviderAccountUsageSnapshotV1
        | Extract<StoredJsonContentEnvelope, Readonly<{ t: 'encrypted' }>>,
): ProviderAccountUsageSnapshotV1 | null {
    const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
    const ciphertext = 't' in content
        ? content.c
        : content.ciphertext;
    const opened = openProviderAccountUsageSnapshotCiphertext({ material, ciphertext });
    if (!opened || !opened.value) return null;

    const parsed = ProviderAccountUsageSnapshotV1Schema.safeParse(opened.value);
    return parsed.success ? parsed.data : null;
}
