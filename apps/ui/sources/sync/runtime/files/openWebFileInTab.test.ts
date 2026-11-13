import { afterEach, describe, expect, it, vi } from 'vitest';
import { openWebFileInTab } from './openWebFileInTab';

afterEach(() => vi.unstubAllGlobals());

// The module keeps the last shown URL across calls, so URLs stay unique across the whole file.
let next = 0;

function stubBrowser(openResults: ReadonlyArray<'tab' | 'blocked'>) {
  const tab = { opener: {} as unknown };
  const results = [...openResults];
  const open = vi.fn((url: string) => {
    void url;
    return results.shift() === 'tab' ? tab : null;
  });
  const createObjectURL = vi.fn((blob: Blob) => {
    void blob;
    return `blob:happier/${++next}`;
  });
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('window', { open });
  vi.stubGlobal(
    'URL',
    Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL }),
  );
  return { tab, open, createObjectURL, revokeObjectURL };
}

describe('openWebFileInTab', () => {
  it('opens the finished bytes with their own type in a tab without an opener', async () => {
    const browser = stubBrowser(['tab']);
    await expect(
      openWebFileInTab(
        new Blob([new Uint8Array([37, 80, 68, 70])]),
        'application/pdf',
      ),
    ).resolves.toEqual({ opened: true });
    const shown = browser.createObjectURL.mock.calls[0][0];
    expect(shown.type).toBe('application/pdf');
    expect(new Uint8Array(await shown.arrayBuffer())).toEqual(
      new Uint8Array([37, 80, 68, 70]),
    );
    expect(browser.open).toHaveBeenCalledWith(
      browser.createObjectURL.mock.results[0].value,
      '_blank',
    );
    expect(browser.tab.opener).toBeNull();
  });

  it('hands back a press-ready open when the browser blocks the expired press', async () => {
    const browser = stubBrowser(['blocked', 'tab']);
    const result = await openWebFileInTab(
      new Blob(['%PDF']),
      'application/pdf',
    );
    expect(result.opened).toBe(false);
    if (result.opened) throw new Error('expected a blocked first open');
    expect(result.open()).toBe(true);
    expect(browser.open).toHaveBeenCalledTimes(2);
    expect(browser.open.mock.calls[1][0]).toBe(browser.open.mock.calls[0][0]);
  });

  it('keeps only the latest shown file alive', async () => {
    const browser = stubBrowser(['tab', 'tab']);
    await openWebFileInTab(new Blob(['a']), 'application/pdf');
    const first = browser.createObjectURL.mock.results[0].value as string;
    expect(browser.revokeObjectURL).not.toHaveBeenCalledWith(first);
    await openWebFileInTab(new Blob(['b']), 'application/pdf');
    const second = browser.createObjectURL.mock.results[1].value as string;
    expect(browser.revokeObjectURL).toHaveBeenCalledWith(first);
    expect(browser.revokeObjectURL).not.toHaveBeenCalledWith(second);
  });
});
