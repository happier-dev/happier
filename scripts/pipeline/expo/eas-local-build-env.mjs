// @ts-check

/**
 * EAS local builds run an `expo doctor` phase via `@expo/build-tools` which can fail
 * for minor dependency drift and block local iteration.
 *
 * We disable that step by default for the pipeline’s local build mode, while still
 * allowing operators/CI to opt back in by explicitly setting the env var.
 *
 * @param {{ baseEnv: Record<string, string>; platform: 'ios' | 'android' }} opts
 * @returns {Record<string, string>}
 */
export function createEasLocalBuildEnv(opts) {
  const env = { ...opts.baseEnv };
  if (!Object.prototype.hasOwnProperty.call(env, 'EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP')) {
    env.EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP = '1';
  }
  if (opts.platform === 'ios') {
    if (!Object.prototype.hasOwnProperty.call(env, 'FASTLANE_XCODEBUILD_SETTINGS_TIMEOUT')) {
      env.FASTLANE_XCODEBUILD_SETTINGS_TIMEOUT = '30';
    }

    // Xcode’s export pipeline can invoke `/usr/bin/rsync` (openrsync) which internally spawns a
    // server-side `rsync` process via PATH. If Homebrew rsync appears before `/usr/bin`, the two
    // implementations can mismatch and fail with:
    //   "rsync: on remote machine: --extended-attributes: unknown option"
    // Ensure `/usr/bin` precedes `/opt/homebrew/bin` so openrsync finds itself for the server side.
    const pathRaw = String(env.PATH ?? '');
    if (pathRaw) {
      const parts = pathRaw.split(':').filter(Boolean);
      const idxUsr = parts.indexOf('/usr/bin');
      const idxBrew = parts.indexOf('/opt/homebrew/bin');
      if (idxUsr !== -1 && idxBrew !== -1 && idxBrew < idxUsr) {
        parts.splice(idxUsr, 1);
        const insertAt = parts.indexOf('/opt/homebrew/bin');
        parts.splice(insertAt === -1 ? 0 : insertAt, 0, '/usr/bin');
        env.PATH = parts.join(':');
      }
    }
  }
  return env;
}
