import type { MachineAccessRecipientCensusResponseV1, MachineKeyPreparationResultV1, MachineRecipientKeyEnvelopeCommitInputV1, MachineRecipientKeyEnvelopeCommitResponseV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { prepareMachineDataKeyEnvelopesV1 } from '@happier-dev/protocol/machines/prepareMachineDataKeyEnvelopesV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { AES256Encryption } from './encryptor';
import { mapCryptoBatchWithYield } from './cryptoBatchYield';
import { SESSION_DATA_KEY_SEAL_CHUNK_SIZE } from './directShareEncryption';

export type CurrentMachineDataKeyEnvelopeTransport = Readonly<{
    fetchPage: (cursor: string | null) => Promise<MachineAccessRecipientCensusResponseV1>;
    patchPage: (request: MachineRecipientKeyEnvelopeCommitInputV1) => Promise<MachineRecipientKeyEnvelopeCommitResponseV1>;
}>;

export async function prepareCurrentMachineDataKeyEnvelopes(params: Readonly<{
    serverId: string;
    machineId: string;
    transport: CurrentMachineDataKeyEnvelopeTransport;
    resolveTransferableMachineDataKey: (page: MachineAccessRecipientCensusResponseV1) => Promise<Uint8Array | null>;
    isHostScopeCurrent: () => boolean;
}>): Promise<MachineKeyPreparationResultV1> {
    return prepareMachineDataKeyEnvelopesV1({
        machineId: params.machineId,
        transport: params.transport,
        resolveTransferableDataKey: params.resolveTransferableMachineDataKey,
        isScopeCurrent: params.isHostScopeCurrent,
        randomBytes: getRandomBytes,
        decodeStoredContent: async (key, content) => (await new AES256Encryption(key).decrypt([decodeBase64(content)]))[0],
        mapRecipients: (items, prepare) => mapCryptoBatchWithYield(items, prepare, { chunkSize: SESSION_DATA_KEY_SEAL_CHUNK_SIZE }),
    });
}
