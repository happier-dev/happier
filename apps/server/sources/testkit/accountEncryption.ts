import tweetnacl from "tweetnacl";

export function createSignedAccountContentBinding(): Readonly<{
    publicKey: string;
    contentPublicKey: Uint8Array<ArrayBuffer>;
    contentPublicKeySig: Uint8Array<ArrayBuffer>;
}> {
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();
    const payload = Buffer.concat([
        Buffer.from("Happy content key v1\u0000", "utf8"),
        Buffer.from(content.publicKey),
    ]);
    return {
        publicKey: Buffer.from(signing.publicKey).toString("hex"),
        contentPublicKey: new Uint8Array(content.publicKey),
        contentPublicKeySig: new Uint8Array(
            tweetnacl.sign.detached(
                payload,
                signing.secretKey,
            ),
        ),
    };
}
