// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';

import { createTriageListWindowStore } from '../../projection/listWindowStore.js';
import { createTriageListPublicationV1 } from './publication.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('settles render-owned planner changes while still following external window publications', async () => {
  // Only the Action transport is replaced; the window, publication and React
  // external-store lifecycle are real.
  const store = createTriageListWindowStore({
    nowMs: Date.now,
    readEntries: async () => ({ v: 1, configuredSources: [], configuredSourcesStatus: 'complete',
      window: { v: 1, rows: [], lanes: [], coverage: 'complete', assembledAtMs: 1 } }),
  });
  const publication = createTriageListPublicationV1();
  const subscribe = (listener: () => void) => store.subscribe(change => {
    publication.synchronize(store.getSnapshot(), change);
    listener();
  });
  const read = () => {
    publication.synchronize(store.getSnapshot());
    return publication.getRevision();
  };
  let renders = 0;
  function List({ label }: Readonly<{ label: string }>) {
    React.useSyncExternalStore(subscribe, read, read);
    // The planner is render-owned, as in TriageListShell. Replacing its local
    // presentation inputs must not look like another external store write.
    publication.setPlanner(() => []);
    renders += 1;
    return <span>{label}:{store.getSnapshot().window === undefined ? 'cold' : 'loaded'}</span>;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => { root.render(<List label="First" />); });
    expect(renders).toBe(1);
    expect(container.textContent).toBe('First:cold');
    act(() => { root.render(<List label="Changed" />); });
    expect(renders).toBe(2);
    await act(async () => { await store.refresh('view'); });
    expect(container.textContent).toBe('Changed:loaded');
    expect(renders).toBeGreaterThan(2);
  } finally {
    act(() => { root.unmount(); });
    store.dispose();
  }
});
