import * as React from 'react';

type PermissionResponse = Readonly<{
    granted: boolean;
}>;

const DEFAULT_PERMISSION: PermissionResponse = { granted: true };

export function useCameraPermissions(): readonly [
    PermissionResponse | null,
    () => Promise<PermissionResponse>,
] {
    return [
        DEFAULT_PERMISSION,
        async () => DEFAULT_PERMISSION,
    ] as const;
}

type CameraViewComponent = React.ComponentType<any> & {
    isModernBarcodeScannerAvailable?: boolean;
    launchScanner?: (...args: any[]) => void;
    dismissScanner?: (...args: any[]) => Promise<void> | void;
    onModernBarcodeScanned?: (...args: any[]) => { remove: () => void };
};

export const CameraView: CameraViewComponent = Object.assign(
    function CameraView(_props: any) {
        return null;
    },
    {
        isModernBarcodeScannerAvailable: false,
        launchScanner: () => {},
        dismissScanner: async () => {},
        onModernBarcodeScanned: () => ({ remove: () => {} }),
    },
);

export const Camera = CameraView;
