const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const { mkdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

// Android's modern default excludes user-installed CAs. Let the platform verify
// certificates against both device stores for HTTP and WebSocket connections.
module.exports = (config, { usesCleartextTraffic }) => {
  config = withAndroidManifest(config, (mod) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    application.$['android:networkSecurityConfig'] = '@xml/happier_network_security_config';
    return mod;
  });

  return withDangerousMod(config, ['android', async (mod) => {
    const resourceDirectory = join(mod.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
    await mkdir(resourceDirectory, { recursive: true });
    // Network security config takes precedence over the manifest cleartext flag;
    // use the same resolved build-properties value rather than a second default.
    await writeFile(join(resourceDirectory, 'happier_network_security_config.xml'), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="${usesCleartextTraffic}">
    <trust-anchors>
      <certificates src="system" />
      <certificates src="user" />
    </trust-anchors>
  </base-config>
</network-security-config>
`);
    return mod;
  }]);
};
