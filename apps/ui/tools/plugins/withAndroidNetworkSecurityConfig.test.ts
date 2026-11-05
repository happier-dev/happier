import { getConfig } from '@expo/config';
import { AndroidConfig, compileModsAsync, withPlugins, XML } from '@expo/config-plugins';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const uiRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pluginPath = './plugins/withAndroidNetworkSecurityConfig.js';

afterEach(() => vi.unstubAllEnvs());

describe('Android network security prebuild', () => {
    it.each([true, false])('trusts device CA stores in release builds with cleartext=%s', async (cleartext) => {
        vi.stubEnv('APP_ENV', 'production');
        vi.stubEnv('HAPPIER_ANDROID_USES_CLEARTEXT_TRAFFIC', String(cleartext));
        const projectRoot = await mkdtemp(join(tmpdir(), 'happier-android-trust-'));
        const mainRoot = join(projectRoot, 'android', 'app', 'src', 'main');
        await mkdir(mainRoot, { recursive: true });
        const manifestPath = join(mainRoot, 'AndroidManifest.xml');
        await writeFile(manifestPath, `
            <manifest xmlns:android="http://schemas.android.com/apk/res/android">
                <uses-permission android:name="android.permission.INTERNET" />
                <application android:name=".MainApplication" android:usesCleartextTraffic="${cleartext}" />
            </manifest>
        `);

        try {
            // Exercise the registered app plugin through Expo's real file mods. Other
            // plugins own unrelated native files and are outside this trust contract.
            for (let pass = 0; pass < 2; pass++) {
                const exp = getConfig(uiRoot, { skipSDKVersionRequirement: true }).exp;
                const plugins = (exp.plugins ?? []).flatMap((entry): Parameters<typeof withPlugins>[1] => {
                    const name = Array.isArray(entry) ? entry[0] : entry;
                    return name === pluginPath ? [[name, Array.isArray(entry) ? entry[1] : undefined]] : [];
                });
                await compileModsAsync(withPlugins(exp, plugins), {
                    projectRoot,
                    platforms: ['android'],
                });

                const manifest = await AndroidConfig.Manifest.readAndroidManifestAsync(manifestPath);
                const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
                const reference = application.$?.['android:networkSecurityConfig'];
                expect(reference).toMatch(/^@xml\/[a-z_]+$/);
                expect(application.$?.['android:usesCleartextTraffic']).toBe(String(cleartext));
                expect(manifest.manifest['uses-permission']).toEqual([
                    { $: { 'android:name': 'android.permission.INTERNET' } },
                ]);

                const resource = join(mainRoot, 'res', 'xml', `${reference?.slice('@xml/'.length)}.xml`);
                const policy = await XML.parseXMLAsync(await readFile(resource, 'utf8'));
                expect(policy).toEqual({
                    'network-security-config': {
                        'base-config': [{
                            $: { cleartextTrafficPermitted: String(cleartext) },
                            'trust-anchors': [{
                                certificates: [
                                    { $: { src: 'system' } },
                                    { $: { src: 'user' } },
                                ],
                            }],
                        }],
                    },
                });
            }
        } finally {
            await rm(projectRoot, { recursive: true, force: true });
        }
    });
});
