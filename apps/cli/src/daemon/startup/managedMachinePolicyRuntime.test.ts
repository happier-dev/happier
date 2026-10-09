import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { ManagedPolicyCensusInputV1Schema } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { readManagedMachinePolicyCensus } from './managedMachinePolicyRuntime';

afterEach(() => vi.restoreAllMocks());
describe('daemon managed policy census transport', () => {
    it('reads only the current signed controller census and rejects unavailable authority rather than inventing empty work', async () => {
        const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            expect(url).toBe('https://home.example/v1/machines/managed/controller/policies');
            const input = ManagedPolicyCensusInputV1Schema.parse(body);
            expect(verifyMachineInstallationProof({ proof: input.proof, publicKey: key.publicKey,
                payload: { version: 1, machineId: input.controller.machineId,
                    installationId: input.controller.installationId, accountId: 'owner',
                    managedPolicyCensus: { homeId: input.homeId } } })).toBe(true);
            return { status: 200, data: { machines: [], targets: [] } };
        });
        const input = { homeId: 'home', controller: { machineId: 'controller', installationId: 'installation' },
            custodianAccountId: 'owner', privateKey: key.secretKey, token: 'owner-token', serverUrl: 'https://home.example' };
        expect(await readManagedMachinePolicyCensus(input)).toEqual({ machines: [], targets: [] });
        vi.mocked(axios.post).mockResolvedValue({ status: 403, data: { machines: [], targets: [] } });
        await expect(readManagedMachinePolicyCensus(input)).rejects.toMatchObject({ code: 'admission_unavailable' });
    });
});
