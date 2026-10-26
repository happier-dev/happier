import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const plugin = require('../../plugins/withIosPodDeploymentTargetFloor.js') as {
    applyPodfile: (contents: string) => string;
};

// Real Expo 54 prebuild output from this checkout's apps/ui/ios (development).
const podfile = readFileSync(new URL('./fixtures/iosPodDeploymentTargetFloor/Podfile', import.meta.url), 'utf8');

describe('iOS pod deployment-target floor', () => {
    it('raises every pod configuration after React Native post_install using the canonical app target', () => {
        const updated = plugin.applyPodfile(podfile);
        expect(updated).toContain("podfile_properties.fetch('ios.deploymentTarget')");
        expect(updated).toContain('installer.pods_project.targets.each');
        expect(updated).toContain("Gem::Version.new(current) < Gem::Version.new(app_deployment_target)");
        expect(updated.indexOf('installer.pods_project.targets.each')).toBeGreaterThan(updated.indexOf('react_native_post_install('));
        expect(updated).toContain("podfile_properties['ios.buildReactNativeFromSource']");
        expect(plugin.applyPodfile(updated)).toBe(updated);
    });

    it('refuses an unknown Podfile rather than silently skipping the floor', () => {
        expect(() => plugin.applyPodfile('post_install do |installer|\nend\n')).toThrow();
    });

    it.runIf(process.platform === 'darwin')('executes the generated floor for resource bundles without lowering higher targets', () => {
        const updated = plugin.applyPodfile(podfile);
        const floor = updated.match(/# BEGIN happier-pod-deployment-target\n([\s\S]*?)\n\s*# END happier-pod-deployment-target/)?.[1];
        expect(floor).toBeDefined();
        // CocoaPods/Xcode objects are the external boundary; execute the real generated Ruby.
        const result = execFileSync('ruby', ['-rjson', '-e', `
          Configuration = Struct.new(:build_settings)
          Target = Struct.new(:build_configurations)
          Project = Struct.new(:targets)
          Installer = Struct.new(:pods_project)
          configurations = ['12.4', '15.0', '16.0', '17.0', '$(inherited)', nil].map { |v| Configuration.new({'IPHONEOS_DEPLOYMENT_TARGET' => v}) }
          installer = Installer.new(Project.new(configurations.map { |c| Target.new([c]) }))
          podfile_properties = {'ios.deploymentTarget' => '16.0'}
          ${floor}
          puts JSON.generate(configurations.map { |c| c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] })
        `], { encoding: 'utf8' });
        expect(JSON.parse(result)).toEqual(['16.0', '16.0', '16.0', '17.0', '$(inherited)', null]);
    });
});
