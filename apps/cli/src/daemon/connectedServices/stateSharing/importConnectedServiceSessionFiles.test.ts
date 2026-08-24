import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { importConnectedServiceSessionFiles } from './importConnectedServiceSessionFiles';

describe('importConnectedServiceSessionFiles', () => {
  it('imports matching nested session files without moving the source files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-import-'));
    const sourceRoot = join(root, 'source');
    const destinationRoot = join(root, 'destination');
    await mkdir(join(sourceRoot, '2026', '05', '21'), { recursive: true });
    await writeFile(join(sourceRoot, '2026', '05', '21', 'rollout.jsonl'), '{"id":"local"}\n');
    await writeFile(join(sourceRoot, '2026', '05', '21', 'state.sqlite'), 'sqlite');

    const result = await importConnectedServiceSessionFiles({
      roots: [{
        sourceRoot,
        destinationRoot,
        includeFile: (relativePath) => relativePath.endsWith('.jsonl'),
      }],
    });

    expect(result).toMatchObject({
      imported: 1,
      skippedIdentical: 0,
      conflicted: 0,
    });
    await expect(readFile(join(destinationRoot, '2026', '05', '21', 'rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"local"}\n');
    await expect(readFile(join(sourceRoot, '2026', '05', '21', 'rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"local"}\n');
    await expect(readdir(join(destinationRoot, '2026', '05', '21'))).resolves.not.toContain('state.sqlite');
  });

  it('does not traverse directory trees excluded by the root filter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-import-directory-filter-'));
    const sourceRoot = join(root, 'source');
    const destinationRoot = join(root, 'destination');
    await mkdir(join(sourceRoot, 'memories'), { recursive: true });
    await mkdir(join(sourceRoot, 'sessions', '2026', '05', '21'), { recursive: true });
    await writeFile(join(sourceRoot, 'history.jsonl'), '{"text":"previous prompt"}\n');
    await writeFile(join(sourceRoot, 'memories', 'raw_memories.md'), '# Previous memory\n');
    await writeFile(join(sourceRoot, 'sessions', '2026', '05', '21', 'rollout.jsonl'), '{"id":"session"}\n');

    const result = await importConnectedServiceSessionFiles({
      roots: [{
        sourceRoot,
        destinationRoot,
        includeDirectory: (relativePath) =>
          relativePath === 'memories' || relativePath.startsWith('memories/'),
      }],
    });

    expect(result).toMatchObject({
      imported: 2,
      skippedIdentical: 0,
      conflicted: 0,
    });
    await expect(readFile(join(destinationRoot, 'history.jsonl'), 'utf8')).resolves.toBe('{"text":"previous prompt"}\n');
    await expect(readFile(join(destinationRoot, 'memories', 'raw_memories.md'), 'utf8')).resolves.toBe('# Previous memory\n');
    await expect(readdir(destinationRoot)).resolves.not.toContain('sessions');
  });

  it('preserves conflicting destination files and is idempotent for existing imported conflicts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-import-conflict-'));
    const sourceRoot = join(root, 'source');
    const destinationRoot = join(root, 'destination');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(destinationRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'rollout.jsonl'), '{"id":"local"}\n');
    await writeFile(join(destinationRoot, 'rollout.jsonl'), '{"id":"main"}\n');

    const first = await importConnectedServiceSessionFiles({
      roots: [{
        sourceRoot,
        destinationRoot,
        includeFile: (relativePath) => relativePath.endsWith('.jsonl'),
      }],
    });

    expect(first).toMatchObject({
      imported: 0,
      skippedIdentical: 0,
      conflicted: 1,
    });
    await expect(readFile(join(destinationRoot, 'rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"main"}\n');
    const conflictEntry = (await readdir(destinationRoot)).find((entry) => entry.startsWith('rollout.happier-import-') && entry.endsWith('.jsonl'));
    expect(conflictEntry).toBeDefined();
    await expect(readFile(join(destinationRoot, conflictEntry!), 'utf8')).resolves.toBe('{"id":"local"}\n');

    const second = await importConnectedServiceSessionFiles({
      roots: [{
        sourceRoot,
        destinationRoot,
        includeFile: (relativePath) => relativePath.endsWith('.jsonl'),
      }],
    });

    expect(second).toMatchObject({
      imported: 0,
      skippedIdentical: 1,
      conflicted: 0,
    });
    const conflictEntries = (await readdir(destinationRoot)).filter((entry) => entry.startsWith('rollout.happier-import-') && entry.endsWith('.jsonl'));
    expect(conflictEntries).toHaveLength(1);
  });

  it('skips a root entirely when the destination root is a symlink to the source root', async () => {
    // Shared-mode staged rebuild regression: `staged/projects` is symlinked to the shared store
    // before the import pass runs. The same-root guard must compare PHYSICAL roots so the pass
    // performs zero work — otherwise every store file is hashed twice against itself, and an
    // append between the two reads mints a `<id>.happier-import-<hash>.jsonl` conflict copy of a
    // file onto itself in the shared store (INC-5).
    const root = await mkdtemp(join(tmpdir(), 'happier-session-import-symlink-root-'));
    const sourceRoot = join(root, 'source');
    const destinationRoot = join(root, 'destination');
    await mkdir(join(sourceRoot, 'project-a'), { recursive: true });
    await writeFile(join(sourceRoot, 'project-a', 'rollout.jsonl'), '{"id":"shared"}\n');
    await writeFile(join(sourceRoot, 'project-a', 'other.jsonl'), '{"id":"other"}\n');
    await symlink(sourceRoot, destinationRoot, 'junction');

    const result = await importConnectedServiceSessionFiles({
      roots: [{
        sourceRoot,
        destinationRoot,
        includeFile: (relativePath) => relativePath.endsWith('.jsonl'),
      }],
    });

    expect(result).toEqual({
      imported: 0,
      skippedIdentical: 0,
      conflicted: 0,
      details: [],
    });
    // The shared store must be untouched: no conflict copies minted onto itself.
    await expect(readdir(join(sourceRoot, 'project-a'))).resolves.toEqual(['other.jsonl', 'rollout.jsonl']);
  });

  it('skips a root entirely when the source root is a symlink to the destination root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-import-symlink-src-'));
    const destinationRoot = join(root, 'store');
    const sourceRoot = join(root, 'linked-store');
    await mkdir(destinationRoot, { recursive: true });
    await writeFile(join(destinationRoot, 'rollout.jsonl'), '{"id":"shared"}\n');
    await symlink(destinationRoot, sourceRoot, 'junction');

    const result = await importConnectedServiceSessionFiles({
      roots: [{
        sourceRoot,
        destinationRoot,
        includeFile: (relativePath) => relativePath.endsWith('.jsonl'),
      }],
    });

    expect(result).toEqual({
      imported: 0,
      skippedIdentical: 0,
      conflicted: 0,
      details: [],
    });
    await expect(readdir(destinationRoot)).resolves.toEqual(['rollout.jsonl']);
  });

  it('still imports when a symlinked destination root resolves to a different physical directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-import-symlink-other-'));
    const sourceRoot = join(root, 'source');
    const physicalDestination = join(root, 'physical-destination');
    const destinationRoot = join(root, 'destination-link');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(physicalDestination, { recursive: true });
    await writeFile(join(sourceRoot, 'rollout.jsonl'), '{"id":"local"}\n');
    await symlink(physicalDestination, destinationRoot, 'junction');

    const result = await importConnectedServiceSessionFiles({
      roots: [{
        sourceRoot,
        destinationRoot,
        includeFile: (relativePath) => relativePath.endsWith('.jsonl'),
      }],
    });

    expect(result).toMatchObject({
      imported: 1,
      skippedIdentical: 0,
      conflicted: 0,
    });
    await expect(readFile(join(physicalDestination, 'rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"local"}\n');
  });

  it('still imports into a not-yet-existing destination beneath a symlinked ancestor when it is not the source root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-import-symlink-ancestor-'));
    const sourceRoot = join(root, 'source');
    const physicalParent = join(root, 'physical-parent');
    const linkedParent = join(root, 'linked-parent');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(physicalParent, { recursive: true });
    await writeFile(join(sourceRoot, 'rollout.jsonl'), '{"id":"local"}\n');
    await symlink(physicalParent, linkedParent, 'junction');
    const destinationRoot = join(linkedParent, 'projects');

    const result = await importConnectedServiceSessionFiles({
      roots: [{
        sourceRoot,
        destinationRoot,
        includeFile: (relativePath) => relativePath.endsWith('.jsonl'),
      }],
    });

    expect(result).toMatchObject({
      imported: 1,
      skippedIdentical: 0,
      conflicted: 0,
    });
    await expect(readFile(join(physicalParent, 'projects', 'rollout.jsonl'), 'utf8')).resolves.toBe('{"id":"local"}\n');
  });

  it('skips a root when a destination reached through a symlinked ancestor resolves to the source root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-import-symlink-pending-'));
    const store = join(root, 'store');
    const sourceRoot = join(store, 'projects');
    const linkedStore = join(root, 'linked-store');
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'rollout.jsonl'), '{"id":"shared"}\n');
    await symlink(store, linkedStore, 'junction');
    const destinationRoot = join(linkedStore, 'projects');

    const result = await importConnectedServiceSessionFiles({
      roots: [{
        sourceRoot,
        destinationRoot,
        includeFile: (relativePath) => relativePath.endsWith('.jsonl'),
      }],
    });

    expect(result).toEqual({
      imported: 0,
      skippedIdentical: 0,
      conflicted: 0,
      details: [],
    });
    await expect(readdir(sourceRoot)).resolves.toEqual(['rollout.jsonl']);
  });
});
