const Constants = {
    statusBarHeight: 0,
    expoConfig: {
        version: '0.0.0',
        extra: {},
        ios: { bundleIdentifier: 'test.bundle.id' },
        android: { package: 'test.package' },
    },
    manifest: null,
    manifest2: null,
    deviceName: null as string | null,
    systemVersion: null as string | null,
    isDevice: false,
    debugMode: false,
    appOwnership: null as string | null,
    executionEnvironment: null as string | null,
    platform: null as any,
    systemFonts: null as any,
    deviceId: null as string | null,
    sessionId: null as string | null,
    installationId: null as string | null,
};

export default Constants;

