import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const plugin = require('../../plugins/withIosSceneLifecycle.js') as {
    applyAppDelegate: (contents: string) => string;
    applySceneManifest: (infoPlist: Record<string, unknown>) => Record<string, unknown>;
};
const plist = require('@expo/plist').default as { parse: (contents: string) => Record<string, unknown> };

// Real Expo 54 prebuild output from this checkout's apps/ui/ios (development).
// AppDelegate also matches mac-host ~/duo-probe/evidence/0.2rc/AppDelegate.swift.orig.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/expo54/${name}`, import.meta.url), 'utf8');

describe('iOS scene prebuild migration', () => {
    it('replaces legacy window startup with a scene delegate while preserving the link owners', () => {
        const original = fixture('AppDelegate.swift');
        const updated = plugin.applyAppDelegate(original);
        expect(updated).not.toContain('UIWindow(frame: UIScreen.main.bounds)');
        expect(updated).toContain('UIWindow(windowScene:');
        expect(updated).toContain('class SceneDelegate: UIResponder, UIWindowSceneDelegate');
        expect(updated).toContain('appDelegate.application(UIApplication.shared, open:');
        expect(updated).toContain('appDelegate.application(UIApplication.shared, continue:');
        // The original overrides remain the only RCTLinkingManager dispatch sites.
        expect(updated.match(/RCTLinkingManager\.application/g)).toHaveLength(2);
        expect(updated).toContain(original.slice(original.indexOf('  // Linking API'), original.indexOf('class ReactNativeDelegate')));
        expect(updated).toContain(original.slice(original.indexOf('  override func sourceURL')));
        for (const callback of ['DidBecomeActive', 'WillResignActive', 'DidEnterBackground', 'WillEnterForeground']) {
            expect(updated).toContain(`appDelegate.application${callback}(UIApplication.shared)`);
        }
        expect(updated).toContain('UIApplicationLaunchOptionsURLKey');
        expect(updated).toContain('UIApplicationLaunchOptionsUserActivityDictionaryKey');
        expect(updated).toContain('connectionOptions.urlContexts');
        expect(updated).toContain('connectionOptions.userActivities');
        expect(plugin.applyAppDelegate(updated)).toBe(updated);
    });

    it('refuses changed or partially migrated startup templates', () => {
        const original = fixture('AppDelegate.swift');
        expect(() => plugin.applyAppDelegate(original.replace('bindReactNativeFactory(factory)', 'customBootstrap()'))).toThrow();
        expect(() => plugin.applyAppDelegate(original.replace('UIWindow(frame: UIScreen.main.bounds)', 'customWindow()'))).toThrow();
        expect(() => plugin.applyAppDelegate('class AppDelegate {}')).toThrow();
        const migrated = plugin.applyAppDelegate(original);
        expect(() => plugin.applyAppDelegate(migrated.replace('UIWindow(windowScene:', 'customWindow(scene:'))).toThrow();
    });

    it('delays debug subscriber startup until its scene window exists, preserving release background launch', () => {
        const updated = plugin.applyAppDelegate(fixture('AppDelegate.swift'));
        expect(updated).toContain('func finishLaunchingFromScene()');
        expect(updated).toMatch(/#if DEBUG[\s\S]*?return true\n#else[\s\S]*?return super.application\(application, didFinishLaunchingWithOptions: launchOptions\)/);
        expect(updated.indexOf('appDelegate.finishLaunchingFromScene()')).toBeGreaterThan(updated.indexOf('factory.startReactNative('));
    });

    it('bootstraps every Release launch once before a scene, then only attaches the retained controller', () => {
        const updated = plugin.applyAppDelegate(fixture('AppDelegate.swift'));
        // UIKit reports .background here even for ordinary user cold launches.
        // Release must not guess launch intent from that state or start a second root in the scene.
        expect(updated).not.toContain('application.applicationState');
        expect(updated).toContain('factory.startReactNative(withModuleName: "main", in: nil, launchOptions: launchOptions)');
        expect(updated).toContain('appDelegate.window?.rootViewController ?? appDelegate.reactNativeDelegate?.takeRootViewControllerForScene()');
        expect(updated).toContain('window.rootViewController = existingController');
        expect(updated).toContain('override func createRootViewController() -> UIViewController');
        expect(updated).toMatch(/#if DEBUG\n\s+factory.startReactNative\(withModuleName: "main", in: window, launchOptions: launchOptions\)\n#else\n\s+fatalError\(/);
    });

    it('declares one application scene and preserves unrelated plist configuration', () => {
        const original = plist.parse(fixture('Info.plist'));
        const updated = plugin.applySceneManifest(original);
        expect(updated).toEqual({
            ...original,
            UIApplicationSceneManifest: {
                UIApplicationSupportsMultipleScenes: false,
                UISceneConfigurations: {
                    UIWindowSceneSessionRoleApplication: [{
                        UISceneConfigurationName: 'Default Configuration',
                        UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
                    }],
                },
            },
        });
        expect(plugin.applySceneManifest(updated)).toEqual(updated);
        expect(() => plugin.applySceneManifest({ UIApplicationSceneManifest: { UIApplicationSupportsMultipleScenes: true } })).toThrow();
    });
});
