// @ts-check

import path from 'node:path';
import { createRequire } from 'node:module';
import { getReleaseRingCatalogEntry, normalizeReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

const require = createRequire(import.meta.url);
const { getAppEnvironmentConfig, normalizeAppEnvironmentId } = require('../../../apps/ui/appVariantConfig.cjs');

/** @typedef {'internaldev' | 'internalpreview' | 'publicdev' | 'preview' | 'production'} MobileReleaseEnvironment */
/** @typedef {'internaldev' | 'internaldev-store' | 'internalpreview' | 'internalpreview-apk' | 'publicdev' | 'publicdev-apk' | 'preview' | 'preview-apk' | 'production' | 'production-apk'} MobileReleaseProfile */

/** @type {readonly Exclude<MobileReleaseEnvironment, 'production'>[]} */
const MOBILE_RELEASE_RING_ENVIRONMENTS = ['internaldev', 'internalpreview', 'publicdev', 'preview'];

/** @type {Readonly<Record<MobileReleaseEnvironment, readonly string[]>>} */
const MOBILE_RELEASE_PROFILE_SUFFIXES = {
  internaldev: ['', '-store'],
  internalpreview: ['', '-apk'],
  publicdev: ['', '-apk'],
  preview: ['', '-apk'],
  production: ['', '-apk'],
};

function titleCase(value) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

/**
 * @param {Exclude<MobileReleaseEnvironment, 'production'>} environment
 */
function createReleaseRingBackedMobileReleaseConfig(environment) {
  const ring = getReleaseRingCatalogEntry(environment);
  const rollingSuffix = ring.rollingReleaseSuffix;
  const supportsRollingRelease = Boolean(ring.supportsMobileStoreSubmit && rollingSuffix);
  const publicLabel = ring.publicLabel;

  return {
    id: environment,
    pipelineDeployEnvironment: ring.embeddedPolicyEnv === 'production' ? 'production' : 'preview',
    profilePrefix: environment,
    supportsNativeSubmit: ring.supportsMobileStoreSubmit,
    supportsApkReleasePublishing: ring.supportsMobileStoreSubmit,
    releaseTag: supportsRollingRelease ? `ui-mobile-${rollingSuffix}` : '',
    releaseTitle: supportsRollingRelease ? `Happier UI Mobile ${titleCase(publicLabel)}` : '',
    releaseNotes: supportsRollingRelease ? `Rolling ${publicLabel} build.` : '',
    prerelease: ring.id !== 'stable',
    rollingTag: supportsRollingRelease,
    generateNotes: false,
    submitAllowFailure: ring.visibility === 'public' && ring.id !== 'stable' && ring.supportsMobileStoreSubmit,
  };
}

const mobileReleaseConfigs = Object.freeze({
  ...Object.fromEntries(
    MOBILE_RELEASE_RING_ENVIRONMENTS.map((environment) => [
      environment,
      createReleaseRingBackedMobileReleaseConfig(environment),
    ]),
  ),
  production: {
    id: 'production',
    pipelineDeployEnvironment: 'production',
    profilePrefix: 'production',
    supportsNativeSubmit: true,
    supportsApkReleasePublishing: true,
    releaseTag: '',
    releaseTitle: '',
    releaseNotes: '',
    prerelease: false,
    rollingTag: false,
    generateNotes: true,
    submitAllowFailure: false,
  },
});

/** @type {readonly MobileReleaseEnvironment[]} */
export const MOBILE_RELEASE_ENVIRONMENTS = Object.freeze([
  ...MOBILE_RELEASE_RING_ENVIRONMENTS,
  'production',
]);

export const MOBILE_RELEASE_ENVIRONMENT_INPUTS = Object.freeze(
  MOBILE_RELEASE_ENVIRONMENTS.map((environment) => formatMobileReleaseEnvironment(environment)),
);
export const MOBILE_RELEASE_ENVIRONMENT_CHOICES = MOBILE_RELEASE_ENVIRONMENT_INPUTS.join('|');
export const MOBILE_STORE_SUBMIT_ENVIRONMENT_INPUTS = Object.freeze(
  MOBILE_RELEASE_ENVIRONMENTS
    .filter((environment) => resolveMobileReleaseEnvironmentConfig(environment).supportsNativeSubmit)
    .map((environment) => formatMobileReleaseEnvironment(environment)),
);
export const MOBILE_STORE_SUBMIT_ENVIRONMENT_CHOICES = MOBILE_STORE_SUBMIT_ENVIRONMENT_INPUTS.join('|');
/** @type {readonly MobileReleaseProfile[]} */
export const MOBILE_RELEASE_PROFILES = Object.freeze(
  MOBILE_RELEASE_ENVIRONMENTS.flatMap((environment) =>
    MOBILE_RELEASE_PROFILE_SUFFIXES[environment].map(
      (suffix) => /** @type {MobileReleaseProfile} */ (`${environment}${suffix}`),
    ),
  ),
);
export const MOBILE_RELEASE_PROFILE_INPUTS = Object.freeze(
  MOBILE_RELEASE_PROFILES.map((profile) => formatMobileReleaseProfile(profile)),
);
export const MOBILE_RELEASE_PROFILE_CHOICES = MOBILE_RELEASE_PROFILE_INPUTS.join('|');

/**
 * @param {string} value
 * @returns {value is MobileReleaseEnvironment}
 */
export function isMobileReleaseEnvironment(value) {
  return MOBILE_RELEASE_ENVIRONMENTS.includes(/** @type {MobileReleaseEnvironment} */ (value));
}

/**
 * @param {unknown} raw
 * @returns {MobileReleaseEnvironment | ''}
 */
export function normalizeMobileReleaseEnvironment(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return '';
  const normalizedReleaseRing = normalizeReleaseRingId(value);
  if (normalizedReleaseRing === 'stable') return 'production';
  if (isMobileReleaseEnvironment(normalizedReleaseRing)) {
    return normalizedReleaseRing;
  }
  const normalizedAppEnvironment = normalizeAppEnvironmentId(value);
  if (isMobileReleaseEnvironment(normalizedAppEnvironment)) return normalizedAppEnvironment;
  if (value === 'production') return 'production';
  return '';
}

/**
 * @param {MobileReleaseEnvironment} environment
 */
export function formatMobileReleaseEnvironment(environment) {
  if (environment === 'production') return 'production';
  if (MOBILE_RELEASE_RING_ENVIRONMENTS.includes(/** @type {Exclude<MobileReleaseEnvironment, 'production'>} */ (environment))) {
    const ring = getReleaseRingCatalogEntry(/** @type {Exclude<MobileReleaseEnvironment, 'production'>} */ (environment));
    return ring.visibility === 'public' ? ring.publicLabel : environment;
  }
  return environment;
}

/**
 * @param {unknown} raw
 * @returns {MobileReleaseProfile | ''}
 */
export function normalizeMobileReleaseProfile(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return '';
  for (const suffix of ['-apk', '-store']) {
    if (!value.endsWith(suffix)) continue;
    const environment = normalizeMobileReleaseEnvironment(value.slice(0, -suffix.length));
    if (!environment) return '';
    const candidate = /** @type {MobileReleaseProfile} */ (`${environment}${suffix}`);
    return MOBILE_RELEASE_PROFILES.includes(candidate) ? candidate : '';
  }
  const environment = normalizeMobileReleaseEnvironment(value);
  if (environment) return environment;
  return MOBILE_RELEASE_PROFILES.includes(/** @type {MobileReleaseProfile} */ (value)) ? /** @type {MobileReleaseProfile} */ (value) : '';
}

/**
 * @param {MobileReleaseProfile} profile
 */
export function formatMobileReleaseProfile(profile) {
  for (const suffix of ['-apk', '-store']) {
    if (!profile.endsWith(suffix)) continue;
    const environment = /** @type {MobileReleaseEnvironment} */ (profile.slice(0, -suffix.length));
    return `${formatMobileReleaseEnvironment(environment)}${suffix}`;
  }
  return formatMobileReleaseEnvironment(/** @type {MobileReleaseEnvironment} */ (profile));
}

/**
 * @param {MobileReleaseEnvironment} environment
 */
export function resolveMobileReleaseEnvironmentConfig(environment) {
  return mobileReleaseConfigs[environment];
}

/**
 * @param {MobileReleaseEnvironment} environment
 * @returns {'preview' | 'production'}
 */
export function resolveMobilePipelineDeployEnvironment(environment) {
  return resolveMobileReleaseEnvironmentConfig(environment).pipelineDeployEnvironment;
}

/**
 * @param {MobileReleaseEnvironment} environment
 */
export function resolveMobileProfilePrefix(environment) {
  return resolveMobileReleaseEnvironmentConfig(environment).profilePrefix;
}

/**
 * @param {MobileReleaseEnvironment} environment
 */
export function resolveMobileProfileInputPrefix(environment) {
  return formatMobileReleaseProfile(/** @type {MobileReleaseProfile} */ (resolveMobileProfilePrefix(environment)));
}

/**
 * @param {MobileReleaseEnvironment} environment
 * @returns {'development' | 'preview' | 'production'}
 */
export function resolveMobileBuildNodeEnvironment(environment) {
  if (environment === 'production') return 'production';
  if (environment === 'internaldev') return 'development';
  return 'preview';
}

/**
 * @param {MobileReleaseEnvironment} environment
 */
export function resolveMobileAppEnvironmentConfig(environment) {
  return getAppEnvironmentConfig(environment);
}

/**
 * @param {MobileReleaseEnvironment} environment
 * @returns {'production' | 'preview' | ''}
 */
export function resolveMobileEmbeddedPolicyEnvironment(environment) {
  return resolveMobileAppEnvironmentConfig(environment).featurePolicyEnv;
}

/**
 * @param {MobileReleaseEnvironment} environment
 */
export function supportsMobileNativeSubmit(environment) {
  return resolveMobileReleaseEnvironmentConfig(environment).supportsNativeSubmit;
}

/**
 * @param {MobileReleaseEnvironment} environment
 */
export function supportsMobileApkReleasePublishing(environment) {
  return resolveMobileReleaseEnvironmentConfig(environment).supportsApkReleasePublishing;
}

/**
 * @param {MobileReleaseEnvironment} environment
 */
export function allowsBestEffortSubmit(environment) {
  return resolveMobileReleaseEnvironmentConfig(environment).submitAllowFailure;
}

/**
 * @param {{ environment: MobileReleaseEnvironment; platform: 'ios' | 'android'; appVersion: string; outDir: string; profile?: string }} input
 */
export function resolveMobileNativeArtifactRelativePath({ environment, platform, appVersion, outDir, profile = '' }) {
  const ext = platform === 'android' ? (profile.endsWith('-apk') ? 'apk' : 'aab') : 'ipa';

  if (environment === 'production') {
    return path.join(outDir, `happier-production-${platform}-v${appVersion}.${ext}`);
  }

  return path.join(outDir, `happier-${formatMobileReleaseEnvironment(environment)}-${platform}.${ext}`);
}

/**
 * @param {{ environment: MobileReleaseEnvironment; appVersion: string }}
 */
export function resolveMobileReleaseMetadata({ environment, appVersion }) {
  const cfg = resolveMobileReleaseEnvironmentConfig(environment);
  if (environment === 'production') {
    return {
      publish: true,
      tag: `ui-mobile-v${appVersion}`,
      title: `Happier UI Mobile v${appVersion}`,
      prerelease: false,
      rollingTag: false,
      generateNotes: true,
      notes: '',
    };
  }

  return {
    publish: cfg.supportsApkReleasePublishing,
    tag: cfg.releaseTag,
    title: cfg.releaseTitle,
    prerelease: cfg.prerelease,
    rollingTag: cfg.rollingTag,
    generateNotes: cfg.generateNotes,
    notes: cfg.releaseNotes,
  };
}
