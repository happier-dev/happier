// Keep the Expo project identity dependency-free so trusted recovery jobs can
// submit already-built artifacts without installing the application workspace.
const EXPO_PROJECT_CONFIG = Object.freeze({
    owner: 'happier-dev',
    slug: 'happier',
    easProjectId: '2a550bd7-e4d2-4f59-ab47-dcb778775cee',
});

module.exports = { EXPO_PROJECT_CONFIG };
