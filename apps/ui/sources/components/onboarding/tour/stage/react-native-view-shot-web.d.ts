declare module 'react-native-view-shot/src/RNViewShot.web' {
    type WebCaptureOptions = Readonly<{
        format: 'png';
        quality: number;
        result: 'data-uri';
    }>;

    const viewShotWeb: Readonly<{
        captureRef: (node: unknown, options: WebCaptureOptions) => Promise<string>;
    }>;

    export default viewShotWeb;
}
