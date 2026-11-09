import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getConfig } from 'expo/config';
import type { ExportedConfig } from 'expo/config-plugins';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
// Actual Expo 55.0.11 generated development delegate; includes RN 0.83 factory API.
const original = readFileSync(new URL('./fixtures/expo55/AppDelegate.swift', import.meta.url), 'utf8');

async function applyConfiguredDelegate(contents: string) {
    const config: ExportedConfig = getConfig(projectRoot, { isModdedConfig: true }).exp;
    const mod = config.mods?.ios?.appDelegate;
    if (!mod) return contents;
    const result = await mod({
        ...config,
        modRawConfig: config,
        modResults: { path: 'AppDelegate.swift', language: 'swift', contents },
        modRequest: {
            projectRoot,
            platformProjectRoot: `${projectRoot}/ios`,
            projectName: 'Happier',
            platform: 'ios',
            modName: 'appDelegate',
            introspect: false,
        },
    });
    return result.modResults.contents;
}

describe('Expo 55 scene lifecycle', () => {
    it('bootstraps every Release launch once without a window, then attaches its retained controller', async () => {
        const updated = await applyConfiguredDelegate(original);
        const startup = updated.slice(updated.indexOf('    reactNativeFactory = factory'), updated.indexOf('  // Linking API'));
        expect(startup.match(/factory.startReactNative\(/g)).toHaveLength(1);
        expect(startup).toMatch(/#if DEBUG[\s\S]*?launchOptionsForScene = launchOptions \?\? \[:\]\n#else[\s\S]*?factory.startReactNative\(withModuleName: "main", in: nil, launchOptions: launchOptions\)\n#endif/);
        expect(updated).not.toContain('UIWindow(frame: UIScreen.main.bounds)');
        expect(updated).toContain('factory.startReactNative(withModuleName: "main", in: nil, launchOptions: launchOptions)');
        expect(updated).toContain('UIWindow(windowScene: windowScene)');
        expect(updated).toContain('window.rootViewController = existingController');
        expect(updated).not.toContain('needsSceneLaunch');
        expect(updated).not.toContain('application.applicationState');
        expect(updated).toContain('return super.application(application, didFinishLaunchingWithOptions: launchOptions)');
        expect(updated.match(/RCTLinkingManager\.application/g)).toHaveLength(2);
        expect(updated).toContain(original.slice(original.indexOf('  // Linking API'), original.indexOf('class ReactNativeDelegate')));
        for (const callback of ['DidBecomeActive', 'WillResignActive', 'DidEnterBackground', 'WillEnterForeground']) {
            expect(updated).toContain(`appDelegate.application${callback}(UIApplication.shared)`);
        }
        expect(updated).toContain('forwardURLs(connectionOptions.urlContexts)');
        expect(updated).toContain('appDelegate.application(UIApplication.shared, continue:');
        expect(await applyConfiguredDelegate(updated)).toBe(updated);
    });

    it('starts Debug with its scene window before the dev-launcher can complete', async () => {
        const updated = await applyConfiguredDelegate(original);
        expect(updated).toContain('factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)');
        expect(updated.indexOf('appDelegate.window = window')).toBeLessThan(updated.indexOf('factory.startReactNative(withModuleName: "main", in: window'));
        expect(updated).not.toContain('finishLaunchingFromScene');
        expect(updated).toContain('UIApplicationLaunchOptionsURLKey');
        const scene = updated.slice(updated.indexOf('// BEGIN happier-scene-delegate'));
        expect(scene.match(/factory.startReactNative\(/g)).toHaveLength(1);
        expect(scene).toMatch(/#if DEBUG[\s\S]*?factory.startReactNative\(withModuleName: "main", in: window, launchOptions: launchOptions\)\n#else\n\s+fatalError/);
    });

    it('rejects unknown or partial startup templates', async () => {
        await expect(applyConfiguredDelegate(original.replace('reactNativeFactory = factory', 'customBootstrap()'))).rejects.toThrow();
        await expect(applyConfiguredDelegate(original.replace('UIWindow(frame: UIScreen.main.bounds)', 'customWindow()'))).rejects.toThrow();
        const migrated = await applyConfiguredDelegate(original);
        await expect(applyConfiguredDelegate(migrated.replace('UIWindow(windowScene:', 'customWindow(scene:'))).rejects.toThrow();
    });

    it('declares one application scene without altering extension or other plist settings', async () => {
        const config: ExportedConfig = getConfig(projectRoot, { isModdedConfig: true }).exp;
        const mod = config.mods?.ios?.infoPlist;
        expect(mod).toBeDefined();
        if (!mod) throw new Error('Missing configured Info.plist mod');
        const initial = { CFBundleDisplayName: 'Happier', UIBackgroundModes: ['remote-notification'], NSSupportsLiveActivities: true };
        const result = await mod({
            ...config,
            modRawConfig: config,
            modResults: initial,
            modRequest: { projectRoot, platformProjectRoot: `${projectRoot}/ios`, projectName: 'Happier', platform: 'ios', modName: 'infoPlist', introspect: false },
        });
        expect(result.modResults).toMatchObject({
            ...initial,
            UIApplicationSceneManifest: {
                UIApplicationSupportsMultipleScenes: false,
                UISceneConfigurations: { UIWindowSceneSessionRoleApplication: [{ UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate' }] },
            },
        });
        await expect(mod({ ...result, modResults: { UIApplicationSceneManifest: { UIApplicationSupportsMultipleScenes: true } } })).rejects.toThrow('Conflicting UIApplicationSceneManifest');
    });
});
