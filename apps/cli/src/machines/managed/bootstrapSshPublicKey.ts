import { createPublicKey } from 'node:crypto';

/** The retained bootstrap key's RFC 4253 public carrier, shared by allocation
 * and invocation-private native file delivery. */
export function sshPublicKey(privateKey: string): string {
    const key = createPublicKey(privateKey).export({ format: 'jwk' });
    if (key.kty !== 'RSA' || !key.n || !key.e) {
        throw Object.assign(new Error('The retained SSH credential is unavailable'), { code: 'credential_unavailable' });
    }
    const field = (bytes: Buffer) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(bytes.length);
        return Buffer.concat([length, bytes]);
    };
    const integer = (value: string) => {
        const bytes = Buffer.from(value, 'base64url');
        return field(bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
    };
    return `ssh-rsa ${Buffer.concat([field(Buffer.from('ssh-rsa')), integer(key.e), integer(key.n)]).toString('base64')}`;
}
