import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SAMPLE_PLUGIN_ID = 'acme.sample';
export const SAMPLE_PLUGIN_PROVIDER_ID = 'sample-provider';
export const SAMPLE_PLUGIN_BACKEND_ID = SAMPLE_PLUGIN_PROVIDER_ID;
export const SAMPLE_PLUGIN_PROVIDER_TITLE = 'Acme Sample CLI';

export const SAMPLE_PLUGIN_FIXTURE_ROOT = fileURLToPath(
    new URL('./fixtures/sample-package/', import.meta.url),
);

export const SAMPLE_PLUGIN_MANIFEST_PATH = join(
    SAMPLE_PLUGIN_FIXTURE_ROOT,
    '.happier-plugin',
    'plugin.json',
);

export const SAMPLE_PLUGIN_DAEMON_PATH = join(
    SAMPLE_PLUGIN_FIXTURE_ROOT,
    'daemon.mjs',
);

export async function materializeSamplePluginFixture(targetRoot: string): Promise<void> {
    await mkdir(join(targetRoot, '.happier-plugin'), { recursive: true });
    await copyFile(SAMPLE_PLUGIN_DAEMON_PATH, join(targetRoot, 'daemon.mjs'));
    await copyFile(SAMPLE_PLUGIN_MANIFEST_PATH, join(targetRoot, '.happier-plugin', 'plugin.json'));
}
