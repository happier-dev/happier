import { expect, it } from 'vitest';
import { createResource } from './resource.js';

it('reuses a loaded page on reveal and refreshes only an actively demanded invalidated page', async () => {
    let reads = 0;
    const resource = createResource(async () => ({ value: ++reads }));
    const other = createResource(async () => ({ value: ++reads }));
    let publications = 0;
    const off = resource.subscribe(() => publications++);
    await resource.demand();
    const first = resource.get();
    await resource.demand();
    expect(resource.get()).toBe(first);
    expect(resource.get().data?.value).toBe(1);
    expect(reads).toBe(1);
    await other.demand();
    resource.invalidate();
    await resource.demand();
    expect(resource.get().data?.value).toBe(3);
    expect(other.get().data?.value).toBe(2);
    expect(publications).toBe(2);
    off();
    resource.invalidate();
    expect(reads).toBe(3);
    await resource.demand();
    expect(resource.get().data?.value).toBe(4);
});

it('drops rows at instance retirement and ignores a retired in-flight read', async () => {
    let finish!: (value: { privateCell: string }) => void;
    const resource = createResource(() => new Promise<{ privateCell: string }>(resolve => { finish = resolve; }));
    const first = resource.demand();
    expect(resource.demand()).toBe(first);
    await Promise.resolve();
    resource.dispose();
    finish({ privateCell: 'retired Account' });
    await first;
    expect(resource.get().data).toBeUndefined();
    await resource.demand();
    expect(resource.get().data).toBeUndefined();

    const held = createResource(async () => ({ privateCell: 'loaded Account' }));
    await held.demand();
    held.dispose();
    expect(held.get().data).toBeUndefined();
});

it('keeps a failed answer visible across reveal until explicit Refresh', async () => {
    let reads = 0;
    const offline = new Error('Machine offline');
    const resource = createResource(async () => { reads++; if (reads === 1) throw offline; return 'recovered'; });
    await resource.demand();
    const failed = resource.get();
    await resource.demand();
    expect(resource.get()).toBe(failed);
    expect(resource.get().error).toBe(offline);
    expect(reads).toBe(1);
    resource.invalidate();
    await resource.demand();
    expect(resource.get().data).toBe('recovered');
    expect(reads).toBe(2);
});
