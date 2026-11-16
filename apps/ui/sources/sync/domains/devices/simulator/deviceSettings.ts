import type { SimulatorPlatformV1 } from '@happier-dev/protocol/devices/simulator/v1';

/**
 * The few test settings the viewer offers by name, and the platform value each one sends through the
 * device operation. The operation contract takes the platform's own value (an iOS content-size
 * category, an Android font scale, a privacy service or Android permission); this is the one place
 * the viewer names them.
 */
export type SimulatorTextSizePreset = 'small' | 'default' | 'large';
export type SimulatorPermissionPreset =
  | 'camera'
  | 'photos'
  | 'location'
  | 'microphone'
  | 'contacts';

export const SIMULATOR_TEXT_SIZE_PRESETS: readonly SimulatorTextSizePreset[] = [
  'small',
  'default',
  'large',
];
export const SIMULATOR_PERMISSION_PRESETS: readonly SimulatorPermissionPreset[] =
  ['camera', 'photos', 'location', 'microphone', 'contacts'];

const TEXT_SIZE_VALUES: Readonly<
  Record<SimulatorPlatformV1, Readonly<Record<SimulatorTextSizePreset, string>>>
> = {
  ios: { small: 'small', default: 'large', large: 'extra-extra-large' },
  android: { small: '0.85', default: '1.0', large: '1.3' },
};

const PERMISSION_VALUES: Readonly<
  Record<
    SimulatorPlatformV1,
    Readonly<Record<SimulatorPermissionPreset, string>>
  >
> = {
  ios: {
    camera: 'camera',
    photos: 'photos',
    location: 'location',
    microphone: 'microphone',
    contacts: 'contacts',
  },
  android: {
    camera: 'android.permission.CAMERA',
    photos: 'android.permission.READ_MEDIA_IMAGES',
    location: 'android.permission.ACCESS_FINE_LOCATION',
    microphone: 'android.permission.RECORD_AUDIO',
    contacts: 'android.permission.READ_CONTACTS',
  },
};

export function simulatorTextSizeValue(
  platform: SimulatorPlatformV1,
  preset: SimulatorTextSizePreset,
): string {
  return TEXT_SIZE_VALUES[platform][preset];
}

export function simulatorPermissionValue(
  platform: SimulatorPlatformV1,
  preset: SimulatorPermissionPreset,
): string {
  return PERMISSION_VALUES[platform][preset];
}
