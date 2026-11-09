import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig } from 'expo/config';
import type { ExportedConfig, IOSConfig, Mod } from 'expo/config-plugins';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
// Existing development apps/ui/ios/Podfile generated with Expo 55.0.11,
// including expo-widgets' post_install hook and extension target.
const podfile = readFileSync(new URL('./fixtures/iosPodDeploymentTargetFloor/Podfile', import.meta.url), 'utf8');

async function applyConfiguredPodfile(contents: string) {
    // Expo 55 registers this real mod but omits it from ModConfig's iOS declaration.
    const config: ExportedConfig & {
        mods?: { ios?: { podfile?: Mod<IOSConfig.Paths.PodfileProjectFile> } };
    } = getConfig(projectRoot, { isModdedConfig: true }).exp;
    const mod = config.mods?.ios?.podfile;
    if (!mod) return contents;
    const result = await mod({
        ...config,
        modRawConfig: config,
        modResults: { path: 'Podfile', language: 'rb', contents },
        modRequest: {
            projectRoot,
            platformProjectRoot: `${projectRoot}/ios`,
            projectName: 'Happier',
            platform: 'ios',
            modName: 'podfile',
            introspect: false,
        },
    });
    return result.modResults.contents;
}

describe('iOS pod deployment-target floor', () => {
    it('applies the floor after React Native and widgets through the configured Podfile mods', async () => {
        const updated = await applyConfiguredPodfile(podfile);
        expect(updated).toContain("podfile_properties.fetch('ios.deploymentTarget')");
        expect(updated).toContain('expo_widgets_post_install(installer)');
        expect(updated.indexOf('installer.pods_project.targets.each')).toBeGreaterThan(updated.indexOf('react_native_post_install('));
        expect(updated.indexOf('installer.pods_project.targets.each')).toBeGreaterThan(updated.indexOf('expo_widgets_post_install('));
        expect(updated).toContain("podfile_properties['expo.useHermesV1']");
        expect(await applyConfiguredPodfile(updated)).toBe(updated);
    });

    it('refuses unknown or partially migrated Podfiles rather than silently skipping the floor', async () => {
        await expect(applyConfiguredPodfile('post_install do |installer|\nend\n')).rejects.toThrow();
        await expect(applyConfiguredPodfile(`${podfile}\n# BEGIN happier-pod-deployment-target\n`)).rejects.toThrow();
    });

    it.runIf(process.platform === 'darwin')('raises resource-bundle and extension pod configurations without lowering higher targets', async () => {
        const updated = await applyConfiguredPodfile(podfile);
        const floor = updated.match(/# BEGIN happier-pod-deployment-target\n([\s\S]*?)\n\s*# END happier-pod-deployment-target/)?.[1];
        expect(floor).toBeDefined();
        // CocoaPods/Xcode objects are the system boundary; execute the generated Ruby unchanged.
        const result = execFileSync('ruby', ['-rjson', '-e', `
          Configuration = Struct.new(:build_settings)
          Target = Struct.new(:name, :build_configurations)
          Project = Struct.new(:targets)
          Installer = Struct.new(:pods_project)
          configurations = ['12.4', '15.1', '16.0', '16.4', '17.0', '$(inherited)', nil].map { |v| Configuration.new({'IPHONEOS_DEPLOYMENT_TARGET' => v}) }
          installer = Installer.new(Project.new([
            Target.new('PrivacyResources', configurations.take(2)),
            Target.new('WidgetPod', configurations.slice(2, 2)),
            Target.new('NotificationServicePod', configurations.drop(4))
          ]))
          podfile_properties = {'ios.deploymentTarget' => '16.4'}
          ${floor}
          puts JSON.generate(configurations.map { |c| c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] })
        `], { encoding: 'utf8' });
        expect(JSON.parse(result)).toEqual(['16.4', '16.4', '16.4', '16.4', '17.0', '$(inherited)', null]);
    });
});
