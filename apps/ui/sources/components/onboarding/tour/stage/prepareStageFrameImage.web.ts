type DecodableImage = {
    src: string;
    decode: () => Promise<void>;
};

type CreateDecodableImage = () => DecodableImage;

export async function decodeStageFrameImage(
    uri: string,
    createImage: CreateDecodableImage = () => new Image(),
): Promise<void> {
    const image = createImage();
    image.src = uri;
    await image.decode();
}
