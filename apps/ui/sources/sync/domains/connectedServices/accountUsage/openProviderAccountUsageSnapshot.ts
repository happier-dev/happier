import {
    ProviderAccountUsageSnapshotV1Schema,
    openProviderAccountUsageSnapshotCiphertext,
    type ProviderAccountUsageSnapshotV1,
    type SealedProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '../resolveAccountScopedCryptoMaterialFromCredentials';

export function openProviderAccountUsageSnapshot(
    credentials: AuthCredentials,
    sealed: SealedProviderAccountUsageSnapshotV1,
): ProviderAccountUsageSnapshotV1 | null {
    const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
    const opened = openProviderAccountUsageSnapshotCiphertext({ material, ciphertext: sealed.ciphertext });
    if (!opened || !opened.value) return null;

    const parsed = ProviderAccountUsageSnapshotV1Schema.safeParse(opened.value);
    return parsed.success ? parsed.data : null;
}
