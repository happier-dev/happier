import {
    assertProfileTransferContentForModeV1,
    ProfileTransferContentV1Schema,
    StoredProfileTransferContentV1Schema,
    type ProfileTransferContentV1,
    type ProfileTransferRowReadResponseV1,
} from '@happier-dev/protocol/profiles/profileTransferV1';
import type { Tx } from '@/storage/inTx';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { PROFILE_TRANSFER_ACCOUNT_KV_KEY } from '@/app/kv/accountScopedKv';
import {
    readReservedAccountScopedKvRowInTx,
    type ReservedAccountScopedKvRowDomain,
    type ReservedAccountScopedKvRowReadResult,
} from '@/app/kv/reservedAccountScopedKvRow';

/** Transfer readers share the sole envelope grammar without loading mutation/resource services. */
export const profileTransferDomain: ReservedAccountScopedKvRowDomain<ProfileTransferContentV1> = {
    label: 'Profile transfer',
    parseStoredEnvelope(value) { const parsed = StoredProfileTransferContentV1Schema.safeParse(value); return parsed.success ? parsed.data : null; },
    parseCandidateEnvelope(value) { const parsed = ProfileTransferContentV1Schema.safeParse(value); return parsed.success ? parsed.data : null; },
    assertEnvelopeForMode: assertProfileTransferContentForModeV1,
};

export async function readProfileTransferControlInTx(tx: Tx, input: Readonly<{ accountId: string }>): Promise<ReservedAccountScopedKvRowReadResult<ProfileTransferContentV1>> {
    return readReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId, physicalKey: PROFILE_TRANSFER_ACCOUNT_KV_KEY, domain: profileTransferDomain });
}

export function profileTransferControlReadResponseV1(result: ReservedAccountScopedKvRowReadResult<ProfileTransferContentV1>): ProfileTransferRowReadResponseV1 {
    return result.status === 'present' ? { status: 'present', revision: result.revision, content: result.envelope } : result;
}

export async function markProfileTransferChangedInTx(tx: Tx, input: Readonly<{ accountId: string; revision: number }>): Promise<number> {
    return markAccountChanged(tx, { accountId: input.accountId, kind: 'account', entityId: PROFILE_TRANSFER_ACCOUNT_KV_KEY,
        hint: { profiles: true, revision: input.revision } });
}
