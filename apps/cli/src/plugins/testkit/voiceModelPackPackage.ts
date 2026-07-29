import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID = 'dev.happier.fixture.voice.zipformer';
export const ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID = 'zipformer-en-20m';

export const ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_ROOT = fileURLToPath(
  new URL('./fixtures/voice-model-packs/zipformer/', import.meta.url),
);

export async function materializeZipformerVoiceModelPackPluginFixture(targetRoot: string): Promise<void> {
  await mkdir(join(targetRoot, '.happier-plugin'), { recursive: true });
  await copyFile(
    join(ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_ROOT, '.happier-plugin', 'plugin.json'),
    join(targetRoot, '.happier-plugin', 'plugin.json'),
  );
  await copyFile(
    join(ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_ROOT, 'daemon.mjs'),
    join(targetRoot, 'daemon.mjs'),
  );
}
