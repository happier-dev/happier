const { withBaseMod } = require('@expo/config-plugins');

const podFloor = `    # BEGIN happier-pod-deployment-target
    # Include resource bundles, which React Native's deployment-target update skips.
    app_deployment_target = podfile_properties.fetch('ios.deploymentTarget')
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |configuration|
        current = configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'].to_s
        if current.match?(/\\A\\d+(?:\\.\\d+)*\\z/) && Gem::Version.new(current) < Gem::Version.new(app_deployment_target)
          configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = app_deployment_target
        end
      end
    end
    # END happier-pod-deployment-target`;

function applyPodfile(contents) {
  if (contents.includes('# BEGIN happier-pod-deployment-target')) {
    if (!contents.includes(podFloor)) throw new Error('Incomplete pod deployment-target migration');
    return contents;
  }
  const anchor = contents.match(/    react_native_post_install\([\s\S]*?\n    \)/g);
  if (anchor?.length !== 1) throw new Error('Unrecognized Expo 54 Podfile post_install');
  return contents.replace(anchor[0], `${anchor[0]}\n\n${podFloor}`);
}

function withIosPodDeploymentTargetFloor(config) {
  // Postprocess the completed Podfile, after the React Native post_install mod.
  return withBaseMod(config, {
    platform: 'ios',
    mod: 'podfile',
    async action(config) {
      const result = await config.modRequest.nextMod(config);
      result.modResults = { ...result.modResults, contents: applyPodfile(result.modResults.contents) };
      return result;
    },
  });
}

module.exports = Object.assign(withIosPodDeploymentTargetFloor, { applyPodfile });
