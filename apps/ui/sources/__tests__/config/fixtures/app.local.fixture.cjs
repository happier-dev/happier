module.exports = {
    expo: {
        name: 'Happier (local override)',
        plugins: [
            ['react-native-audio-api', { iosBackgroundMode: false }],
        ],
        ios: {
            infoPlist: {
                NSPhotoLibraryUsageDescription: 'Local override: access photos for sharing.',
            },
        },
    },
};
