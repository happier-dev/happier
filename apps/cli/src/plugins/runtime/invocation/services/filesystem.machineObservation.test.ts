import { appendFile, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPluginFileSystemService } from './filesystem';

describe('Machine filesystem identity observation', () => {
  const cleanups: (() => void | Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

  async function fixture(machineNative = true) {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-identity-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'system.journal');
    await writeFile(path, 'journal');
    const lifetime = new AbortController();
    const retirement = new AbortController();
    cleanups.push(() => lifetime.abort());
    let current = true;
    const service = createPluginFileSystemService({
      roots: { pluginData: root, projects: new Map() },
      machineNative, signal: lifetime.signal, retirementSignal: retirement.signal, isOccurrenceCurrent: () => current,
    });
    return { root, path, service, lifetime, retire: () => { current = false; },
      retireOpen: () => { current = false; retirement.abort(); } };
  }

  it('retires open observation without cancelling admitted finite work and refuses its successor', async () => {
    const f = await fixture();
    const events: unknown[] = [];
    const observed = await f.service.observeMachinePath({ absolutePath: f.path }, event => { events.push(event); });
    cleanups.push(() => observed.dispose());
    f.retireOpen();
    expect(f.lifetime.signal.aborted).toBe(false);
    await expect(observed.read()).rejects.toMatchObject({ code: 'plugin_fs_aborted' });
    await expect(f.service.observeMachinePath({ absolutePath: f.path }, () => {}))
      .rejects.toMatchObject({ code: 'plugin_generation_stale' });
    expect(events).toEqual([]);
  });

  it('publishes changed native metadata but ignores equal notifications and unrelated files', async () => {
    const f = await fixture();
    const events: unknown[] = [];
    const observed = await f.service.observeMachinePath({ absolutePath: f.path }, event => { events.push(event); });
    cleanups.push(() => observed.dispose());
    expect(observed.identity).toEqual(expect.any(String));
    await appendFile(f.path, '-append');
    await vi.waitFor(() => expect(events).toEqual([{ kind: 'changed', identity: observed.identity, size: 14 }]));
    await writeFile(join(f.root, 'unrelated'), 'unrelated');
    // Let the real native notifications drain; this is a test observation window, not a product timer.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(events).toEqual([{ kind: 'changed', identity: observed.identity, size: 14 }]);
    await rename(f.path, `${f.path}.rotated`);
    await writeFile(f.path, 'replacement');
    await vi.waitFor(() => expect(events).toContainEqual({ kind: 'changed', identity: expect.any(String), size: 11 }));
    const changed = events.filter((event): event is { kind: 'changed'; identity: string } =>
      typeof event === 'object' && event !== null && 'kind' in event && event.kind === 'changed'
      && 'identity' in event && typeof event.identity === 'string');
    expect(changed.at(-1)?.identity).not.toBe(observed.identity);
    const count = events.length;
    await observed.dispose();
    await observed.dispose();
    await expect(observed.read()).rejects.toMatchObject({ code: 'plugin_fs_aborted' });
    await rename(f.path, `${f.path}.after-dispose`);
    await writeFile(f.path, 'after-dispose');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(events).toHaveLength(count);
  });

  it('publishes in-place updates to preallocated journal files without changing their identity or size', async () => {
    const f = await fixture();
    const events: unknown[] = [];
    const observed = await f.service.observeMachinePath({ absolutePath: f.path }, event => { events.push(event); });
    cleanups.push(() => observed.dispose());
    const file = await open(f.path, 'r+');
    try { await file.write('updated', 0, 'utf8'); }
    finally { await file.close(); }
    await vi.waitFor(() => expect(events).toEqual([{ kind: 'changed', identity: observed.identity, size: 7 }]));
    expect(await observed.read()).toEqual({ identity: observed.identity, size: 7 });
    await writeFile(join(f.root, 'unrelated'), 'unrelated');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(events).toHaveLength(1);
  });

  it('reports truncation without inventing a replacement identity and guards current metadata reads', async () => {
    const f = await fixture();
    const events: unknown[] = [];
    const observed = await f.service.observeMachinePath({ absolutePath: f.path }, event => { events.push(event); });
    cleanups.push(() => observed.dispose());
    await writeFile(f.path, 'j');
    await vi.waitFor(() => expect(events).toEqual([{ kind: 'changed', identity: observed.identity, size: 1 }]));
    expect(await observed.read()).toEqual({ identity: observed.identity, size: 1 });
    f.retire();
    await expect(observed.read()).rejects.toMatchObject({ code: 'plugin_generation_stale' });
  });

  it('includes an append between the initial metadata read and native watcher registration', async () => {
    const f = await fixture();
    const native = await import('node:fs/promises');
    const original = native.stat;
    // Substitute only the OS read boundary: the returned stat predates a real
    // append completed before the incumbent watcher can register its baseline.
    const raced = vi.spyOn(native, 'stat').mockImplementationOnce(async (path, options) => {
      const before = await original(path, options);
      await appendFile(f.path, '-raced');
      return before;
    });
    try {
      const observed = await f.service.observeMachinePath({ absolutePath: f.path }, () => {});
      cleanups.push(() => observed.dispose());
      expect(observed.size).toBe(13);
    } finally { raced.mockRestore(); }
  });

  it('does not publish an older attachment sample after a newer native change', async () => {
    const f = await fixture();
    const native = await import('node:fs/promises');
    const original = native.stat;
    let metadataReads = 0;
    // Delay only an OS stat result after capturing it. A real append wakes the
    // incumbent native watcher while attachment is still reconciling metadata.
    const raced = vi.spyOn(native, 'stat').mockImplementation(async (path, options) => {
      const before = await original(path, options);
      if (typeof options === 'object' && options?.bigint === true && ++metadataReads === 2) {
        await appendFile(f.path, '-raced');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return before;
    });
    try {
      const sizes: (number | null)[] = [];
      const observed = await f.service.observeMachinePath({ absolutePath: f.path }, event => {
        if (event.kind === 'changed') sizes.push(event.size);
      });
      cleanups.push(() => observed.dispose());
      await vi.waitFor(() => expect(sizes).toContain(13));
      await observed.dispose();
      expect(sizes).toEqual([13]);
    } finally { raced.mockRestore(); }
  });

  it('does not turn native metadata disclosure into Machine content, write or removal authority', async () => {
    const f = await fixture();
    const path = { root: 'machine', relativePath: 'system.journal' } as const;
    // @ts-expect-error Machine paths are intentionally absent from PluginPath.
    await expect(f.service.readFile(path)).rejects.toMatchObject({ code: 'plugin_fs_root_unavailable' });
    // @ts-expect-error Machine metadata observation does not authorize writes.
    await expect(f.service.writeFile(path, new TextEncoder().encode('forbidden'))).rejects.toMatchObject({ code: 'plugin_fs_root_unavailable' });
    // @ts-expect-error Machine metadata observation does not authorize removal.
    await expect(f.service.remove(path)).rejects.toMatchObject({ code: 'plugin_fs_root_unavailable' });
    expect(await readFile(f.path, 'utf8')).toBe('journal');
  });

  it('lets trusted Machine plugins observe undeclared paths while retaining the Machine context boundary', async () => {
    const ordinary = await fixture(false);
    await expect(ordinary.service.observeMachinePath({ absolutePath: ordinary.path }, () => {}))
      .rejects.toMatchObject({ code: 'plugin_fs_machine_context_required' });
    const f = await fixture();
    const undisclosed = createPluginFileSystemService({
      roots: { pluginData: f.root, projects: new Map() }, machineNative: true,
      signal: f.lifetime.signal, isOccurrenceCurrent: () => true,
    });
    const observed = await undisclosed.observeMachinePath({ absolutePath: f.path }, () => {});
    cleanups.push(() => observed.dispose());
    expect(observed.size).toBe(7);
    await expect(f.service.observeMachinePath({ absolutePath: 'system.journal' }, () => {}))
      .rejects.toMatchObject({ code: 'plugin_fs_path_denied' });
    const outside = await mkdtemp(`${f.root}-sibling-`);
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, 'system.journal'), 'outside');
    await symlink(join(outside, 'system.journal'), join(f.root, 'escape'));
    for (const absolutePath of [join(outside, 'system.journal'), join(f.root, 'escape')]) {
      const observation = await f.service.observeMachinePath({ absolutePath }, () => {});
      cleanups.push(() => observation.dispose());
      expect(observation.size).toBe(7);
    }
  });

  it('cancels without emissions and reports stale authority before publishing replacement identity', async () => {
    const f = await fixture();
    const cancelled = new AbortController();
    cancelled.abort();
    const events: unknown[] = [];
    await expect(f.service.observeMachinePath({ absolutePath: f.path }, event => { events.push(event); }, { signal: cancelled.signal }))
      .rejects.toMatchObject({ code: 'plugin_fs_aborted' });
    const observed = await f.service.observeMachinePath({ absolutePath: f.path }, event => { events.push(event); });
    cleanups.push(() => observed.dispose());
    f.retire();
    await rename(f.path, `${f.path}.rotated`);
    await writeFile(f.path, 'replacement');
    await vi.waitFor(() => expect(events).toEqual([{ kind: 'unavailable', code: 'plugin_generation_stale', retryable: false }]));
    f.lifetime.abort();
    await appendFile(f.path, 'after-retirement');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(events).toHaveLength(1);
  });

  it('settles disposal after native cleanup and makes external cancellation silent', async () => {
    const f = await fixture();
    const signal = new AbortController();
    const events: unknown[] = [];
    const observed = await f.service.observeMachinePath({ absolutePath: f.path }, event => { events.push(event); }, { signal: signal.signal });
    signal.abort();
    await observed.dispose();
    await expect(observed.read()).rejects.toMatchObject({ code: 'plugin_fs_aborted' });
    const native = await import('node:fs/promises');
    const reads = vi.spyOn(native, 'stat');
    try {
      await rename(f.path, `${f.path}.rotated`);
      await writeFile(f.path, 'replacement');
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(events).toEqual([]);
      expect(reads).not.toHaveBeenCalled();
    } finally { reads.mockRestore(); }
  });

  it('ends observation explicitly when its admitted parent is replaced', async () => {
    const f = await fixture();
    const events: unknown[] = [];
    const observed = await f.service.observeMachinePath({ absolutePath: f.path }, event => { events.push(event); });
    const retiredRoot = `${f.root}.retired`;
    cleanups.push(() => rm(retiredRoot, { recursive: true, force: true }));
    cleanups.push(() => observed.dispose());
    await rename(f.root, retiredRoot);
    await vi.waitFor(() => expect(events).toEqual([{ kind: 'unavailable', code: 'plugin_fs_observation_unavailable', retryable: true }]));
    await observed.dispose();
  });

  it('maps native watcher permission failure and stops after a throwing consumer', async () => {
    const f = await fixture();
    const native = await import('node:fs');
    const denied = vi.spyOn(native, 'watch').mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    try {
      await expect(f.service.observeMachinePath({ absolutePath: f.path }, () => {}))
        .rejects.toMatchObject({ code: 'plugin_fs_permission_denied' });
    } finally { denied.mockRestore(); }
    const emit = vi.fn(() => { throw new Error('consumer retired'); });
    const observed = await f.service.observeMachinePath({ absolutePath: f.path }, emit);
    cleanups.push(() => observed.dispose());
    await rename(f.path, `${f.path}.rotated`);
    await writeFile(f.path, 'replacement');
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
    await observed.dispose();
    await rename(f.path, `${f.path}.next`);
    await writeFile(f.path, 'next');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
