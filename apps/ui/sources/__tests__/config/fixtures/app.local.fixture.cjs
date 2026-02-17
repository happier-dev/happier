module.exports = {
    expo: {
        name: 'Happier (local override)',
        ios: {
            infoPlist: {
                NSPhotoLibraryUsageDescription: 'Local override: access photos for sharing.',
            },
        },
    },
};

