import { useImage, useTypeface } from '@shopify/react-native-skia';

/** The same shipped typography faces and mark used by the web moment painter. */
export function useNativeMomentEnvironment(w: number, h: number, dpr: number, onError?: (error: Error) => void) {
    const mono = useTypeface(require('@/assets/fonts/IBMPlexMono-Regular.ttf'), onError);
    const monoStrong = useTypeface(require('@/assets/fonts/IBMPlexMono-SemiBold.ttf'), onError);
    const sans = useTypeface(require('@/assets/fonts/Inter-Regular.ttf'), onError);
    const sansMedium = useTypeface(require('@/assets/fonts/Inter-Medium.ttf'), onError);
    const sansStrong = useTypeface(require('@/assets/fonts/Inter-SemiBold.ttf'), onError);
    const mark = useImage(require('@/assets/images/logo-black.png'));
    return mono && monoStrong && sans && sansMedium && sansStrong ? { w, h, dpr, mono, monoStrong, sans, sansMedium, sansStrong, mark } : null;
}
