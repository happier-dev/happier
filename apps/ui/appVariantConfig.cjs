const path = require('node:path');

// Keep this module dependency-free so it can run in GitHub Actions before `yarn install`.
// We load the canonical release ring catalog from the checked-in CJS entrypoint.
const releaseRings = require(path.resolve(__dirname, '..', '..', 'packages', 'release-runtime', 'releaseRings.cjs'));
const { getReleaseRingCatalogEntry, normalizeReleaseRingId } = releaseRings;

function resolveLogicalVariantFromRing(ring) {
    if (ring.expoAppEnv === 'production') return 'production';
    if (ring.expoAppEnv === 'development') return 'development';
    return 'preview';
}

function buildRingBackedConfig(ringId, overrides) {
    const ring = getReleaseRingCatalogEntry(ringId);
    return {
        id: ringId,
        logicalVariant: resolveLogicalVariantFromRing(ring),
        name: overrides.name,
        iosBundleId: overrides.iosBundleId,
        androidPackage: overrides.androidPackage,
        scheme: overrides.scheme,
        updatesChannel: ring.expoUpdatesChannel,
        featurePolicyEnv: ring.embeddedPolicyEnv,
        enableAssociatedDomains: overrides.enableAssociatedDomains,
    };
}

function buildProductionConfig(overrides) {
    const ring = getReleaseRingCatalogEntry('stable');
    return {
        id: 'production',
        logicalVariant: 'production',
        name: overrides.name,
        iosBundleId: overrides.iosBundleId,
        androidPackage: overrides.androidPackage,
        scheme: overrides.scheme,
        updatesChannel: ring.expoUpdatesChannel,
        featurePolicyEnv: ring.embeddedPolicyEnv,
        enableAssociatedDomains: overrides.enableAssociatedDomains,
    };
}

const APP_ENVIRONMENT_CONFIGS = {
    internaldev: buildRingBackedConfig('internaldev', {
        name: 'Happier (internal dev)',
        iosBundleId: 'dev.happier.app.dev.internal',
        androidPackage: 'dev.happier.app.internaldev',
        scheme: 'happier-internaldev',
        enableAssociatedDomains: false,
    }),
    internalpreview: buildRingBackedConfig('internalpreview', {
        name: 'Happier (internal preview)',
        iosBundleId: 'dev.happier.app.internalpreview',
        androidPackage: 'dev.happier.app.internalpreview',
        scheme: 'happier-internalpreview',
        enableAssociatedDomains: false,
    }),
    publicdev: buildRingBackedConfig('publicdev', {
        name: 'Happier (dev)',
        iosBundleId: 'dev.happier.app.publicdev',
        androidPackage: 'dev.happier.app.publicdev',
        scheme: 'happier-dev',
        enableAssociatedDomains: false,
    }),
    preview: buildRingBackedConfig('preview', {
        name: 'Happier (preview)',
        iosBundleId: 'dev.happier.app.preview',
        androidPackage: 'dev.happier.app.preview',
        scheme: 'happier-preview',
        enableAssociatedDomains: false,
    }),
    production: buildProductionConfig({
        name: 'Happier',
        iosBundleId: 'dev.happier.app',
        androidPackage: 'dev.happier.app',
        scheme: 'happier',
        enableAssociatedDomains: true,
    }),
};

function normalizeAppEnvironmentId(raw) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value) return '';
    if (Object.prototype.hasOwnProperty.call(APP_ENVIRONMENT_CONFIGS, value)) {
        return value;
    }

    const ring = normalizeReleaseRingId(value);
    if (!ring) return '';
    return ring === 'stable' ? 'production' : ring;
}

function getAppEnvironmentConfig(raw) {
    const normalized = normalizeAppEnvironmentId(raw) || 'internaldev';
    return APP_ENVIRONMENT_CONFIGS[normalized];
}

module.exports = {
    APP_ENVIRONMENT_CONFIGS,
    getAppEnvironmentConfig,
    normalizeAppEnvironmentId,
};
