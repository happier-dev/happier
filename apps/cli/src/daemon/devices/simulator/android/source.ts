const ANDROID_SIMULATOR_SOURCE_PREFIX = 'simulator:android:';
const ANDROID_SIMULATOR_SOURCE_SUFFIX = ':screen';

export function parseAndroidSerialFromSimulatorSourceId(sourceId: string): string | null {
    if (!sourceId.startsWith(ANDROID_SIMULATOR_SOURCE_PREFIX) || !sourceId.endsWith(ANDROID_SIMULATOR_SOURCE_SUFFIX)) {
        return null;
    }
    const serial = sourceId
        .slice(ANDROID_SIMULATOR_SOURCE_PREFIX.length, -ANDROID_SIMULATOR_SOURCE_SUFFIX.length)
        .trim();
    return serial.length > 0 ? serial : null;
}
