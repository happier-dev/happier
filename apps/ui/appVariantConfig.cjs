const APP_ENVIRONMENT_ALIASES = {
    development: 'internaldev',
    dev: 'publicdev',
    canary: 'internalpreview',
    stable: 'production',
    prod: 'production',
};

const APP_ENVIRONMENT_CONFIGS = {
    internaldev: {
        id: 'internaldev',
        logicalVariant: 'development',
        name: 'Happier (internal dev)',
        iosBundleId: 'dev.happier.app.internaldev',
        androidPackage: 'dev.happier.app.internaldev',
        scheme: 'happier-internaldev',
        updatesChannel: 'internaldev',
        featurePolicyEnv: '',
        enableAssociatedDomains: false,
    },
    internalpreview: {
        id: 'internalpreview',
        logicalVariant: 'preview',
        name: 'Happier (internal preview)',
        iosBundleId: 'dev.happier.app.internalpreview',
        androidPackage: 'dev.happier.app.internalpreview',
        scheme: 'happier-internalpreview',
        updatesChannel: 'internalpreview',
        featurePolicyEnv: 'preview',
        enableAssociatedDomains: false,
    },
    publicdev: {
        id: 'publicdev',
        logicalVariant: 'preview',
        name: 'Happier (dev)',
        iosBundleId: 'dev.happier.app.publicdev',
        androidPackage: 'dev.happier.app.publicdev',
        scheme: 'happier-publicdev',
        updatesChannel: 'publicdev',
        featurePolicyEnv: 'preview',
        enableAssociatedDomains: false,
    },
    preview: {
        id: 'preview',
        logicalVariant: 'preview',
        name: 'Happier (preview)',
        iosBundleId: 'dev.happier.app.preview',
        androidPackage: 'dev.happier.app.preview',
        scheme: 'happier-preview',
        updatesChannel: 'preview',
        featurePolicyEnv: 'preview',
        enableAssociatedDomains: false,
    },
    production: {
        id: 'production',
        logicalVariant: 'production',
        name: 'Happier',
        iosBundleId: 'dev.happier.app',
        androidPackage: 'dev.happier.app',
        scheme: 'happier',
        updatesChannel: 'production',
        featurePolicyEnv: 'production',
        enableAssociatedDomains: true,
    },
};

function normalizeAppEnvironmentId(raw) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value) return '';
    if (Object.prototype.hasOwnProperty.call(APP_ENVIRONMENT_ALIASES, value)) {
        return APP_ENVIRONMENT_ALIASES[value];
    }
    return Object.prototype.hasOwnProperty.call(APP_ENVIRONMENT_CONFIGS, value) ? value : '';
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
