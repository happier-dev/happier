import type { ReactNode } from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import {
  createHostApiStub,
  createSurfaceContext,
} from '../surfaceFixture.testSupport.js';
import type { PluginUiPresentationHost } from '../presentationHost/context.js';
import { PluginUiProviderInternal } from './PluginUiProvider.js';
import { Checkbox, Item, List } from './index.js';

function mountInHost(
  children: ReactNode,
  host: Partial<PluginUiPresentationHost> = {},
) {
  const context = createSurfaceContext();
  const presentationHost = {
    renderMarkdown: () => null,
    renderPopover: () => null,
    renderIcon: () => null,
    renderCheckboxMark: ({ state, size }: { state: string; size: string }) => (
      <i data-testid="host-mark" data-state={state} data-size={size} />
    ),
    ...host,
  } as unknown as PluginUiPresentationHost;
  return mountThroughReactNativeWeb(
    <PluginUiProviderInternal
      hostApi={createHostApiStub(context)}
      context={context}
      presentationHost={presentationHost}
    >
      {children}
    </PluginUiProviderInternal>,
  );
}

const byTestId = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('Checkbox', () => {
  it('is one named checkbox in the host mark: checked, unchecked and a partly checked group', () => {
    const changes: boolean[] = [];
    const mount = mountInHost(
      <>
        <Checkbox
          testID="on"
          checked
          label="Viewed"
          accessibilityLabel="confirm.ts, viewed on GitHub"
          onChange={(next) => {
            changes.push(next);
          }}
        />
        <Checkbox
          testID="off"
          checked={false}
          label="Viewed"
          size="compact"
          onChange={(next) => {
            changes.push(next);
          }}
        />
        <Checkbox
          testID="group"
          checked="mixed"
          label="Select all"
          onChange={(next) => {
            changes.push(next);
          }}
        />
      </>,
    );
    try {
      const on = byTestId(mount.container, 'on')!;
      expect(on.getAttribute('role')).toBe('checkbox');
      expect(on.getAttribute('aria-checked')).toBe('true');
      expect(on.getAttribute('aria-label')).toBe(
        'confirm.ts, viewed on GitHub',
      );
      expect(
        on
          .querySelector('[data-testid="host-mark"]')
          ?.getAttribute('data-state'),
      ).toBe('checked');
      const off = byTestId(mount.container, 'off')!;
      expect(off.getAttribute('aria-checked')).toBe('false');
      expect(off.getAttribute('aria-label')).toBe('Viewed');
      expect(
        off
          .querySelector('[data-testid="host-mark"]')
          ?.getAttribute('data-size'),
      ).toBe('compact');
      const group = byTestId(mount.container, 'group')!;
      expect(group.getAttribute('aria-checked')).toBe('mixed');
      act(() => {
        on.click();
        off.click();
        group.click();
      });
      // Checked clears, unchecked checks, and a partly checked group checks the whole group.
      expect(changes).toEqual([false, true, true]);
    } finally {
      mount.unmount();
    }
  });

  it('shows a pending save as a busy box that ignores presses, and a disabled box refuses them', () => {
    const changes: boolean[] = [];
    const mount = mountInHost(
      <>
        <Checkbox
          testID="saving"
          checked={false}
          pending
          label="Viewed"
          onChange={(next) => {
            changes.push(next);
          }}
        />
        <Checkbox
          testID="off"
          checked={false}
          disabled
          label="Unavailable"
          onChange={(next) => {
            changes.push(next);
          }}
        />
      </>,
    );
    try {
      const saving = byTestId(mount.container, 'saving')!;
      expect(saving.getAttribute('aria-busy')).toBe('true');
      expect(saving.getAttribute('aria-checked')).toBe('false');
      expect(byTestId(mount.container, 'saving-pending')).not.toBeNull();
      expect(saving.querySelector('[data-testid="host-mark"]')).toBeNull();
      const off = byTestId(mount.container, 'off')!;
      expect(off.getAttribute('aria-disabled')).toBe('true');
      act(() => {
        saving.click();
        off.click();
      });
      expect(changes).toEqual([]);
    } finally {
      mount.unmount();
    }
  });

  it('keeps an unknown box in place without drawing or announcing it', () => {
    const mount = mountInHost(
      <Checkbox
        testID="file"
        checked={null}
        label="Viewed"
        onChange={() => {}}
      />,
    );
    try {
      expect(mount.container.querySelector('[role="checkbox"]')).toBeNull();
      const reserved = byTestId(mount.container, 'file-unknown')!;
      expect(reserved.getAttribute('aria-hidden')).toBe('true');
      expect(reserved.querySelector('[data-testid="host-mark"]')).toBeNull();
      // The label still takes its width, so the row does not move when the answer arrives.
      expect(reserved.textContent).toBe('Viewed');
    } finally {
      mount.unmount();
    }
  });

  it('draws its own box without a host mark', () => {
    const mount = mountInHost(
      <Checkbox testID="plain" checked label="Viewed" onChange={() => {}} />,
      { renderCheckboxMark: undefined },
    );
    try {
      const plain = byTestId(mount.container, 'plain')!;
      expect(plain.getAttribute('aria-checked')).toBe('true');
      expect(plain.querySelector('[data-testid="host-mark"]')).toBeNull();
    } finally {
      mount.unmount();
    }
  });

  it('as a row accessory outside the row press, toggles without opening the row', () => {
    const events: string[] = [];
    const mount = mountInHost(
      <List
        accessibilityLabel="Files"
        sections={[{ key: 'files', data: ['src/a.ts'] }]}
        keyForItem={(path) => path}
        renderItem={(path) => (
          <Item
            title={path}
            onPress={() => {
              events.push('row');
            }}
            accessoryOutsidePressable
            accessory={
              <Checkbox
                testID="mark"
                checked={false}
                label="Viewed"
                onChange={(next) => {
                  events.push(`viewed:${String(next)}`);
                }}
              />
            }
          />
        )}
      />,
    );
    try {
      act(() => {
        byTestId(mount.container, 'mark')!.click();
      });
      expect(events).toEqual(['viewed:true']);
    } finally {
      mount.unmount();
    }
  });
});
