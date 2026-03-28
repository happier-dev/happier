// @ts-check

import path from 'node:path';
import { createRequire } from 'node:module';
import { getReleaseRingCatalogEntry } from '@happier-dev/release-runtime/releaseRings';

const require = createRequire(import.meta.url);
const { getAppEnvironmentConfig, normalizeAppEnvironmentId } = require('../../../apps/ui/appVariantConfig.cjs');

/** @typedef {'internaldev' | 'internalpreview' | 'publicdev' | 'preview' | 'production'} MobileReleaseEnvironment */

/** @type {readonly MobileReleaseEnvironment[]} */
export const MOBILE_RELEASE_ENVIRONMENTS = ['internaldev', 'internalpreview', 'publicdev', 'preview', 'production'];
export const MOBILE_RELEASE_ENVIRONMENT_INPUTS = ['internaldev', 'internalpreview', 'dev', 'preview', 'production'];
export const MOBILE_RELEASE_ENVIRONMENT_CHOICES = MOBILE_RELEASE_ENVIRONMENT_INPUTS.join('|');
export const MOBILE_STORE_SUBMIT_ENVIRONMENT_INPUTS = ['dev', 'preview', 'production'];
export const MOBILE_STORE_SUBMIT_ENVIRONMENT_CHOICES = MOBILE_STORE_SUBMIT_ENVIRONMENT_INPUTS.join('|');

const mobileReleaseConfigs = {
  internaldev: {
    id: 'internaldev',
    pipelineDeployEnvironment: 'preview',
    profilePrefix: 'internaldev',
    supportsNativeSubmit: false,
    supportsApkReleasePublishing: false,
    releaseTag: '',
    releaseTitle: '',
    releaseNotes: '',
    prerelease: true,
    rollingTag: false,
    generateNotes: false,
    submitAllowFailure: false,
  },
  internalpreview: {
    id: 'internalpreview',
    pipelineDeployEnvironment: 'preview',
    profilePrefix: 'internalpreview',
    supportsNativeSubmit: false,
    supportsApkReleasePublishing: false,
    releaseTag: '',
    releaseTitle: '',
    releaseNotes: '',
    prerelease: true,
    rollingTag: false,
    generateNotes: false,
    submitAllowFailure: false,
  },
  publicdev: {
    id: 'publicdev',
    pipelineDeployEnvironment: 'preview',
    profilePrefix: 'publicdev',
    supportsNativeSubmit: true,
    supportsApkReleasePublishing: true,
    releaseTag: `ui-mobile-${getReleaseRingCatalogEntry('publicdev').rollingReleaseSuffix}`,
    releaseTitle: 'Happier UI Mobile Dev',
    releaseNotes: 'Rolling dev build.',
    prerelease: true,
    rollingTag: true,
    generateNotes: false,
    submitAllowFailure: true,
  },
  preview: {
    id: 'preview',
    pipelineDeployEnvironment: 'preview',
    profilePrefix: 'preview',
    supportsNativeSubmit: true,
    supportsApkReleasePublishing: true,
    releaseTag: `ui-mobile-${getReleaseRingCatalogEntry('preview').rollingReleaseSuffix}`,
    releaseTitle: 'Happier UI Mobile Preview',
    releaseNotes: 'Rolling preview build.',
    prerelease: true,
    rollingTag: true,
    generateNotes: false,
    submitAllowFailure: true,
  },
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
};

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
  if (value === 'dev' || value === 'publicdev' || value === 'public-dev' || value === 'public_dev') {
    return 'publicdev';
  }
  const normalizedAppEnvironment = normalizeAppEnvironmentId(value);
  if (isMobileReleaseEnvironment(normalizedAppEnvironment)) return normalizedAppEnvironment;
  if (value === 'preview' || value === 'production') return /** @type {MobileReleaseEnvironment} */ (value);
  return '';
}

/**
 * @param {MobileReleaseEnvironment} environment
 */
export function formatMobileReleaseEnvironment(environment) {
  return environment === 'publicdev' ? 'dev' : environment;
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
