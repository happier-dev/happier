import { expect, describe, it } from "vitest";
import { pbkdf2_sha512 } from "./pbkdf2_sha512";
import { decodeHex } from "../formats/hex";

// Test Vectors
// https://stackoverflow.com/questions/15593184/pbkdf2-hmac-sha-512-test-vectors

const VECTORS = [
    {
        password: 'password',
        salt: 'salt',
        iterations: 1,
        keyLen: 64,
        output: decodeHex('867f70cf1ade02cff3752599a3a53dc4af34c7a669815ae5d513554e1c8cf252c02d470a285a0501bad999bfe943c08f050235d7d68b1da55e63f73b60a57fce')
    },
    {
        password: 'password',
        salt: 'salt',
        iterations: 2,
        keyLen: 64,
        output: decodeHex('e1d9c16aa681708a45f5c7c4e215ceb66e011a2e9f0040713f18aefdb866d53cf76cab2868a39b9f7840edce4fef5a82be67335c77a6068e04112754f27ccf4e')
    },
    {
        password: 'password',
        salt: 'salt',
        iterations: 4096,
        keyLen: 64,
        output: decodeHex('d197b1b33db0143e018b12f3d1d1479e6cdebdcc97c5c0f87f6902e072f457b5143f30602641b3d55cd335988cb36b84376060ecd532e039b742a239434af2d5')
    },
    {
        password: 'passwordPASSWORDpassword',
        salt: 'saltSALTsaltSALTsaltSALTsaltSALTsalt',
        iterations: 4096,
        keyLen: 64,
        output: decodeHex('8c0511f4c6e597c6ac6315d8f0362e225f3c501495ba23b868c005174dc4ee71115b59f9e60cd9532fa33e0f75aefe30225c583a186cd82bd4daea9724a3d3b8')
    }
]

describe('pbkdf2_sha512', () => {
    it('should process test vectors', async () => {
        for (let vec of VECTORS) {
            let res = await pbkdf2_sha512(vec.password, vec.salt, vec.iterations, vec.keyLen);
            expect(res).toEqual(vec.output);
        }
    });
});