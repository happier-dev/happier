import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { getConfig } = require('expo/config');
const xcode = require('xcode');
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

test('configured widget target can import pods compiled at the canonical deployment floor', async () => {
    const config = getConfig(projectRoot, { isModdedConfig: true }).exp;
    const request = {
        projectRoot, platformProjectRoot: `${projectRoot}/ios`, projectName: 'HelloWorld',
        platform: 'ios', introspect: false,
    };
    const properties = await config.mods.ios.podfileProperties({
        ...config, modRawConfig: config, modResults: {},
        modRequest: { ...request, modName: 'podfileProperties' },
    });
    // Use Expo 55.0.11's real template project and execute the actual SDK
    // configuration chain; no target-generation or floor decisions are mocked.
    const project = xcode.project(fileURLToPath(new URL('./fixtures/expo55/project.pbxproj', import.meta.url)));
    project.parseSync();
    const result = await config.mods.ios.xcodeproj({
        ...config, modRawConfig: config, modResults: project,
        modRequest: { ...request, modName: 'xcodeproj' },
    });
    const configurations = Object.values(result.modResults.pbxXCBuildConfigurationSection())
        .filter(value => typeof value === 'object' && value.buildSettings?.INFOPLIST_FILE === 'ExpoWidgetsTarget/Info.plist');
    assert.ok(configurations.length > 0, 'The real widget plugin must generate its target');
    assert.deepEqual(
        [...new Set(configurations.map(value => value.buildSettings.IPHONEOS_DEPLOYMENT_TARGET.replaceAll('"', '')))],
        [properties.modResults['ios.deploymentTarget']],
    );
});
