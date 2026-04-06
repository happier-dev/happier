// @ts-check

function parseNonNegativeInt(raw) {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function splitFlags(raw) {
  return String(raw ?? '').trim().split(/\s+/).filter(Boolean);
}

function ensureFlag(parts, flag, predicate = (candidate) => candidate === flag) {
  if (!parts.some(predicate)) parts.push(flag);
}

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

  // External contributors (and many local setups) won't have Sentry credentials configured.
  // The Sentry React Native integrations can fail the build when upload is attempted without auth.
  // Default to skipping auto upload unless the auth token is explicitly provided (or the operator overrides).
  if (!Object.prototype.hasOwnProperty.call(env, 'SENTRY_DISABLE_AUTO_UPLOAD')) {
    const sentryAuthToken = String(env.SENTRY_AUTH_TOKEN ?? '').trim();
    if (!sentryAuthToken) env.SENTRY_DISABLE_AUTO_UPLOAD = 'true';
  }

  if (opts.platform === 'android') {
    const gradleHeapMb = parseNonNegativeInt(env.HAPPIER_EAS_ANDROID_GRADLE_HEAP_MB) ?? 8192;
    const kotlinDaemonHeapMb = parseNonNegativeInt(env.HAPPIER_EAS_ANDROID_KOTLIN_DAEMON_HEAP_MB) ?? 2048;
    const gradleWorkersMax = parseNonNegativeInt(env.HAPPIER_EAS_ANDROID_GRADLE_WORKERS_MAX) ?? 1;
    const gradleJvmArgs = `-Xmx${gradleHeapMb}m -Dfile.encoding=UTF-8`;
    const kotlinDaemonJvmArgs = `-Xmx${kotlinDaemonHeapMb}m`;

    const preferIpv4Raw = String(env.HAPPIER_EAS_ANDROID_PREFER_IPV4 ?? '').trim().toLowerCase();
    const preferIpv4 = preferIpv4Raw ? preferIpv4Raw !== '0' && preferIpv4Raw !== 'false' : true;
    const javaToolOptions = splitFlags(env.JAVA_TOOL_OPTIONS);
    ensureFlag(javaToolOptions, `-Xmx${gradleHeapMb}m`, (candidate) => /^-Xmx/i.test(candidate));
    ensureFlag(javaToolOptions, '-Dfile.encoding=UTF-8', (candidate) => candidate.startsWith('-Dfile.encoding='));
    if (preferIpv4) {
      ensureFlag(javaToolOptions, '-Djava.net.preferIPv4Stack=true');
      ensureFlag(javaToolOptions, '-Djava.net.preferIPv4Addresses=true');
    }
    if (javaToolOptions.length > 0) env.JAVA_TOOL_OPTIONS = javaToolOptions.join(' ');

    if (!Object.prototype.hasOwnProperty.call(env, 'HAPPIER_ANDROID_GRADLE_JVMARGS')) {
      env.HAPPIER_ANDROID_GRADLE_JVMARGS = gradleJvmArgs;
    }
    if (!Object.prototype.hasOwnProperty.call(env, 'ORG_GRADLE_PROJECT_org.gradle.jvmargs')) {
      env['ORG_GRADLE_PROJECT_org.gradle.jvmargs'] = env.HAPPIER_ANDROID_GRADLE_JVMARGS;
    }
    if (!Object.prototype.hasOwnProperty.call(env, 'ORG_GRADLE_PROJECT_kotlin.daemon.jvmargs')) {
      env['ORG_GRADLE_PROJECT_kotlin.daemon.jvmargs'] = kotlinDaemonJvmArgs;
    }

    const gradleOptions = splitFlags(env.GRADLE_OPTS);
    ensureFlag(gradleOptions, `-Xmx${gradleHeapMb}m`, (candidate) => /^-Xmx/i.test(candidate));
    ensureFlag(gradleOptions, '-Dfile.encoding=UTF-8', (candidate) => candidate.startsWith('-Dfile.encoding='));
    ensureFlag(gradleOptions, '-Dorg.gradle.daemon=false', (candidate) => candidate.startsWith('-Dorg.gradle.daemon='));
    ensureFlag(gradleOptions, '-Dorg.gradle.parallel=false', (candidate) => candidate.startsWith('-Dorg.gradle.parallel='));
    ensureFlag(
      gradleOptions,
      `-Dorg.gradle.workers.max=${gradleWorkersMax}`,
      (candidate) => candidate.startsWith('-Dorg.gradle.workers.max='),
    );
    ensureFlag(
      gradleOptions,
      `-Dkotlin.daemon.jvm.options=-Xmx${kotlinDaemonHeapMb}m`,
      (candidate) => candidate.startsWith('-Dkotlin.daemon.jvm.options='),
    );
    if (gradleOptions.length > 0) env.GRADLE_OPTS = gradleOptions.join(' ');
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
