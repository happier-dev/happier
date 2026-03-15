function isWebCameraApiAvailable(): boolean {
    if (typeof navigator === 'undefined') return false;
    return Boolean((navigator as any)?.mediaDevices?.getUserMedia);
}

export function isWebQrScannerSupported(): boolean {
    return isWebCameraApiAvailable();
}
