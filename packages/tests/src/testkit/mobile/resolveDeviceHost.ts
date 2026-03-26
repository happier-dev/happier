export type MobileE2ePlatform = 'android' | 'ios';

function resolveDeviceHostOverride(env: NodeJS.ProcessEnv): string {
  const raw = (env.HAPPIER_E2E_MOBILE_DEVICE_HOST ?? '').trim();
  return raw;
}

function resolveAndroidEmulatorHostAlias(params: { host: string }): string {
  const host = params.host.trim().toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1') return '10.0.2.2';
  return params.host;
}

export function resolveDeviceVisibleBaseUrl(params: Readonly<{
  platform: MobileE2ePlatform;
  baseUrl: string;
  env?: NodeJS.ProcessEnv;
}>): string {
  const env = params.env ?? process.env;
  const override = resolveDeviceHostOverride(env);
  const url = new URL(params.baseUrl);

  if (override) {
    url.hostname = override;
    return url.toString().replace(/\/$/, '');
  }

  if (params.platform === 'android') {
    url.hostname = resolveAndroidEmulatorHostAlias({ host: url.hostname });
  }

  return url.toString().replace(/\/$/, '');
}
