import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { devcontainerNativeFlags, materializeDevcontainerConfiguration } from './configuration.js';

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

it.each(['file', 'inline'] as const)('gives %s configurations an owned workspace volume without changing authored files', async kind => {
  const workspaceFolder = await mkdtemp(join(tmpdir(), 'happier-contained-devcontainer-'));
  try {
    const configPath = join(workspaceFolder, '.devcontainer', 'devcontainer.json');
    await mkdir(dirname(configPath));
    const config = JSON.stringify({ image: 'example:latest', workspaceFolder: '/work/project',
      workspaceMount: `type=bind,source=${workspaceFolder},target=/work/project`, build: { dockerfile: 'Dockerfile' } });
    await writeFile(configPath, config);
    const materialized = await materializeDevcontainerConfiguration({ workspaceFolder, configPath,
      configuration: kind === 'file' ? { kind } : { kind, config } });
    const flags = devcontainerNativeFlags(materialized);
    expect(flags).toContain('--override-config');
    const effective = JSON.parse(await readFile(flags[flags.indexOf('--override-config') + 1]!, 'utf8'));
    expect(effective.workspaceMount).toBe('type=volume,source=${localEnv:COMPOSE_PROJECT_NAME}-workspace,target=/work/project');
    expect(effective.build).toEqual({ dockerfile: 'Dockerfile' });
    expect(await readFile(configPath, 'utf8')).toBe(config);
  } finally { await rm(workspaceFolder, { recursive: true, force: true }); }
});
