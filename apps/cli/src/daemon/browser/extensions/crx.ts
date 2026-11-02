import { createHash, createPublicKey, createVerify } from 'node:crypto';

// Chromium d8666e3dae2a3e155e3feaf1894be6476a7f020d,
// components/crx_file/{crx3.proto,crx_verifier.cc}: production publisher SPKI
// hash and RSA_PKCS1_SHA256/ECDSA_SHA256 proofs over signed header + archive.
const STORE_PUBLISHER_KEY_HASH = '61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf';
const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\0', 'utf8');

export type VerifiedStoreCrx = Readonly<{
    extensionId: string;
    publicKey: Buffer;
    archive: Buffer;
}>;

export function extensionIdFromPublicKey(publicKey: Buffer): string {
    return idFromBytes(createHash('sha256').update(publicKey).digest().subarray(0, 16));
}

function idFromBytes(bytes: Buffer): string {
    return Array.from(bytes.toString('hex'), (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
}

type Field = Readonly<{ number: number; bytes: Buffer }>;

function readFields(bytes: Buffer): Field[] {
    let offset = 0;
    const fields: Field[] = [];
    const varint = (): bigint => {
        let value = 0n;
        // Protobuf varints encode uint64 in at most ten octets.
        for (let shift = 0n; shift < 70n; shift += 7n) {
            if (offset >= bytes.length) throw new Error('Malformed CRX protobuf');
            const byte = bytes[offset++];
            if (shift === 63n && byte > 1) throw new Error('Malformed CRX protobuf');
            value |= BigInt(byte & 127) << shift;
            if (!(byte & 128)) return value;
        }
        throw new Error('Malformed CRX protobuf');
    };
    while (offset < bytes.length) {
        const tag = varint();
        if (tag > 0xffffffffn || tag < 8n) throw new Error('Malformed CRX protobuf');
        const number = Number(tag >> 3n);
        const wire = Number(tag & 7n);
        if (wire === 0) varint();
        else if (wire === 1) offset += 8;
        else if (wire === 5) offset += 4;
        else if (wire === 2) {
            const length = varint();
            if (length > BigInt(bytes.length - offset)) throw new Error('Malformed CRX protobuf');
            const end = offset + Number(length);
            fields.push({ number, bytes: bytes.subarray(offset, end) });
            offset = end;
        } else throw new Error('Unsupported CRX protobuf field');
        if (offset > bytes.length) throw new Error('Malformed CRX protobuf');
    }
    return fields;
}

function lastField(fields: Field[], number: number): Buffer | undefined {
    let found: Buffer | undefined;
    for (const field of fields) if (field.number === number) found = field.bytes;
    return found;
}

export function verifyStoreCrx3(bytes: Buffer, expectedExtensionId: string): VerifiedStoreCrx {
    if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'Cr24' || bytes.readUInt32LE(4) !== 3) {
        throw new Error('Only CRX3 extension packages are supported');
    }
    const headerEnd = 12 + bytes.readUInt32LE(8);
    if (headerEnd >= bytes.length) throw new Error('Malformed CRX header');
    const header = readFields(bytes.subarray(12, headerEnd));
    const signedHeader = lastField(header, 10000);
    const signedId = signedHeader && lastField(readFields(signedHeader), 1);
    if (!signedHeader || signedId?.length !== 16) throw new Error('CRX has no signed extension identity');
    const extensionId = idFromBytes(signedId);
    if (extensionId !== expectedExtensionId) throw new Error('CRX extension identity does not match the requested extension');
    const archive = bytes.subarray(headerEnd);
    const signedHeaderSize = Buffer.alloc(4);
    signedHeaderSize.writeUInt32LE(signedHeader.length);
    let developerKey: Buffer | undefined;
    let publisherFound = false;
    for (const field of header) {
        if (field.number !== 2 && field.number !== 3) continue;
        const proof = readFields(field.bytes);
        const publicKey = lastField(proof, 1);
        const signature = lastField(proof, 2);
        if (!publicKey || !signature) throw new Error('CRX proof is incomplete');
        const key = createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
        if (key.asymmetricKeyType !== (field.number === 2 ? 'rsa' : 'ec')) {
            throw new Error('CRX proof key does not match its signature algorithm');
        }
        const verifier = createVerify('SHA256');
        verifier.update(SIGNATURE_CONTEXT);
        verifier.update(signedHeaderSize);
        verifier.update(signedHeader);
        verifier.update(archive);
        if (!verifier.verify(key, signature)) throw new Error('CRX signature verification failed');
        const keyHash = createHash('sha256').update(publicKey).digest();
        if (idFromBytes(keyHash.subarray(0, 16)) === extensionId) developerKey = publicKey;
        if (keyHash.toString('hex') === STORE_PUBLISHER_KEY_HASH) publisherFound = true;
    }
    if (!developerKey) throw new Error('CRX developer proof is missing');
    if (!publisherFound) throw new Error('Chrome Web Store publisher proof is missing');
    return { extensionId, publicKey: developerKey, archive };
}
