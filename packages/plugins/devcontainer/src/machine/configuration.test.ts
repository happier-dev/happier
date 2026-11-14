import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { materializeDevcontainerConfiguration } from './configuration.js';

it('materializes distinct inline configurations beside project configuration without replacing it', async () => {
  const workspaceFolder = await mkdtemp(join(tmpdir(), 'happier-inline-devcontainer-'));
  try {
    const authoredPath = join(workspaceFolder, '.devcontainer', 'devcontainer.json');
    await mkdir(dirname(authoredPath));
    const authored = '{"image":"project:original"}';
    await writeFile(authoredPath, authored);
    const firstQuery = { workspaceFolder, configuration: { kind: 'inline' as const,
      config: '{"image":"ubuntu:24.04","postCreateCommand":"printf INLINE_SETUP_OK"}' } };
    const first = await materializeDevcontainerConfiguration(firstQuery);
    const second = await materializeDevcontainerConfiguration({ workspaceFolder,
      configuration: { kind: 'inline', config: '{"image":"debian:stable"}' } });

    expect(dirname(first.configPath!)).toBe(dirname(authoredPath));
    expect(dirname(second.configPath!)).toBe(dirname(authoredPath));
    expect(first.configPath).not.toBe(second.configPath);
    expect(await readFile(first.configPath!, 'utf8')).toBe(firstQuery.configuration.config);
    expect(await readFile(second.configPath!, 'utf8')).toBe('{"image":"debian:stable"}');
    expect(await materializeDevcontainerConfiguration(firstQuery)).toEqual(first);
    expect(await readFile(authoredPath, 'utf8')).toBe(authored);
  } finally { await rm(workspaceFolder, { recursive: true, force: true }); }
});
