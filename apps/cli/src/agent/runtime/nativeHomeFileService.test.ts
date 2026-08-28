import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAgentNativeHomeReadService } from './nativeHomeFileService';

describe('createAgentNativeHomeReadService', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('reads only exact files declared by the Agent native-home descriptor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-agent-native-home-'));
    roots.push(root);
    await writeFile(join(root, 'auth.json'), '{"account":"work"}');
    const service = createAgentNativeHomeReadService({
      root,
      declaredFileIds: ['auth.json'],
    });

    await expect(service?.readFiles(['auth.json'])).resolves.toEqual({
      'auth.json': expect.any(Uint8Array),
    });
    await expect(service?.readFiles(['settings.json']))
      .rejects.toThrow('connected_service_native_home_credential_file_undeclared');
  });
});
