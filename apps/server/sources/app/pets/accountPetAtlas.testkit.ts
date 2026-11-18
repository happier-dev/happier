// Specs that supply decoded pixels at the codec boundary still use a WebP header.
export function webpAtlasHeader({ width, height }: { width: number; height: number }): Uint8Array {
    const bytes = Buffer.alloc(30);
    bytes.write("RIFF", 0);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write("WEBPVP8X", 8);
    bytes.writeUInt32LE(10, 16);
    bytes.writeUIntLE(width - 1, 24, 3);
    bytes.writeUIntLE(height - 1, 27, 3);
    return new Uint8Array(bytes);
}
