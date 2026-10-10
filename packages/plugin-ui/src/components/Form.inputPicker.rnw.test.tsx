import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ActionFormHints } from '@happier-dev/plugin-sdk/actions';
import type { PluginInputTypeReferenceV1 } from '@happier-dev/plugin-sdk';
import {
  invokeInputTypePicker,
  type InputTypePickerHostV1,
  type ResolvedInputTypeV1,
} from '@happier-dev/protocol/inputs/runtime';

import {
  HappierInputPickerProvider,
  type HappierInputPickerPort,
  type HappierInputPickerResult,
} from '../presentation/form/inputPicker.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { Form } from './index.js';
import { PluginUiProvider } from './PluginUiProvider.js';

const repositoryType = { pluginId: 'com.acme.inputs', localId: 'repository' } as const;
const declared: ResolvedInputTypeV1 = {
  identity: repositoryType,
  occurrenceId: 'occurrence-1',
  definition: {
    id: 'repository', title: 'Repository', semantic: 'repository',
    valueSchema: { type: 'string', minLength: 1 },
    options: { resource: 'repositories' }, picker: 'repository-picker',
  },
};

// The plugin author declares the typed field; the host resolves its choices before the Form sees them.
const repositoryField = {
  path: 'repository', title: 'Repository', widget: 'select' as const, inputType: repositoryType,
  options: [{ value: 'happier', label: 'happier' }, { value: 'website', label: 'website' }],
};
const hints: ActionFormHints = {
  title: 'Track checks',
  fields: [{ path: 'note', title: 'Note', widget: 'text' }, repositoryField],
};

type Harness = Readonly<{
  port: HappierInputPickerPort;
  setType: (type: ResolvedInputTypeV1 | null) => void;
  answer: (settlement: unknown) => void;
  opened: () => number;
}>;

/**
 * A host port over the real Protocol picker owner: type admission, retirement and the
 * schema/options check are `invokeInputTypePicker`'s. Only the plugin's picker renderer — the
 * genuine boundary — answers from the test.
 */
function createHarness(): Harness {
  let current: ResolvedInputTypeV1 | null = declared;
  let settlement: unknown = { kind: 'cancelled' };
  let opened = 0;
  const host = (options: readonly { value: unknown; label: string }[] | undefined): InputTypePickerHostV1 => ({
    resolveType: async () => current,
    resolveOptions: async () => options?.flatMap((option) => typeof option.value === 'string'
      ? [{ value: option.value, label: option.label }] : []) ?? { errorCode: 'input_type_options_unavailable' },
    openPicker: async () => { opened += 1; return settlement; },
  });
  const port: HappierInputPickerPort = {
    describe: (field) => field.inputType && current?.definition.picker
      ? { label: 'Browse…', accessibilityLabel: `Browse for ${field.title}` } : null,
    pick: async (request) => {
      const result = await invokeInputTypePicker({
        field: { path: request.field.path, title: request.field.title, widget: 'select', inputType: repositoryType },
        ...(typeof request.value === 'string' ? { value: request.value } : {}),
        host: host(request.options), signal: request.signal,
      });
      return result.status === 'error' ? { status: 'error', message: `Refused: ${result.reasonCode}` } : result;
    },
  };
  return {
    port,
    setType: (type) => { current = type; },
    answer: (next) => { settlement = next; },
    opened: () => opened,
  };
}

/** Presses the picker control and lets its settlement land (the host answers asynchronously). */
async function choose(control: HTMLElement | null): Promise<void> {
  expect(control, 'expected the picker control').not.toBeNull();
  await act(async () => {
    control?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mountForm(port: HappierInputPickerPort | null, value: Record<string, unknown>, onChange = vi.fn(), initialHints: ActionFormHints = hints) {
  const context = createSurfaceContext();
  const mount = mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <HappierInputPickerProvider port={port}>
        <Form hints={initialHints} value={value} onChange={onChange} onSubmit={() => undefined} />
      </HappierInputPickerProvider>
    </PluginUiProvider>,
  );
  const browse = () => mount.container.querySelector<HTMLElement>('[aria-label="Browse for Repository"]');
  return { mount, browse, onChange };
}

describe('public Form custom pickers', () => {
  it('writes only the canonical host UsageQuery picker answer into the author field', async () => {
    const inputType = { hostType: 'usageQuery' } as const satisfies PluginInputTypeReferenceV1;
    const queryHints: ActionFormHints = { fields: [hints.fields![0]!, {
      path: 'query', title: 'Usage', widget: 'json', inputType,
    }] };
    let answer: unknown = { kind: 'completed', input: {
      agents: ['codex', 'claude', 'codex'], session: 'session', costBasis: 'reported', metric: 'cost', breakdown: ['machine'],
    } };
    const host: InputTypePickerHostV1 = {
      resolveType: async () => { throw new Error('Host input must not discover a plugin'); },
      resolveOptions: async () => { throw new Error('Host input has no contributed inventory'); },
      openPicker: async () => { throw new Error('Host input has no contributed picker'); },
      openHostPicker: async () => answer,
    };
    const port: HappierInputPickerPort = {
      describe: field => field.inputType && 'hostType' in field.inputType
        ? { label: 'Browse…', accessibilityLabel: 'Browse for Usage' } : null,
      pick: async request => {
        const result = await invokeInputTypePicker({ field: queryHints.fields![1]!, host, signal: request.signal });
        return result.status === 'error' ? { status: 'error', message: result.reasonCode } : result;
      },
    };
    const original = { note: 'Keep this note', query: { agents: ['saved'] } };
    const { mount, onChange } = mountForm(port, original, vi.fn(), queryHints);
    const browse = () => mount.container.querySelector<HTMLElement>('[aria-label="Browse for Usage"]');
    await choose(browse());
    expect(onChange).toHaveBeenCalledWith({ note: 'Keep this note', query: expect.objectContaining({
      agents: ['claude', 'codex'], session: ['session'], costBasis: 'reported', metric: 'cost', breakdown: ['machine'],
    }) });
    onChange.mockClear();
    answer = { kind: 'completed', input: { accountId: 'someone-else' } };
    await choose(browse());
    expect(onChange).not.toHaveBeenCalled();
    expect(mount.container.querySelector('[role="alert"]')?.textContent).toContain('input_type_value_invalid');
    expect(original).toEqual({ note: 'Keep this note', query: { agents: ['saved'] } });
    mount.unmount();
  });
  it('cancels a host query picker when the author replaces its semantic host input type', async () => {
    let settle: ((answer: HappierInputPickerResult) => void) | undefined;
    let signal: AbortSignal | undefined;
    const port: HappierInputPickerPort = {
      describe: () => ({ label: 'Browse…', accessibilityLabel: 'Browse for Repository' }),
      pick: request => { signal = request.signal; return new Promise(resolve => { settle = resolve; }); },
    };
    const hostHints: ActionFormHints = { fields: [{ path: 'repository', title: 'Repository', widget: 'json',
      inputType: { hostType: 'usageQuery' } }] };
    const { mount, browse, onChange } = mountForm(port, { repository: {} }, vi.fn(), hostHints);
    await choose(browse());
    const context = createSurfaceContext();
    await mount.render(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <HappierInputPickerProvider port={port}>
        <Form hints={{ fields: [{ ...hostHints.fields![0]!, inputType: { hostType: 'workspace' } }] }}
          value={{ repository: {} }} onChange={onChange} onSubmit={() => undefined} />
      </HappierInputPickerProvider>
    </PluginUiProvider>);
    expect(signal?.aborted).toBe(true);
    await act(async () => { settle?.({ status: 'selected', value: { metric: 'cost' } }); });
    expect(onChange).not.toHaveBeenCalled();
    mount.unmount();
  });
  it('ignores a late choice when the mounted author replaces the field’s choices', async () => {
    let settle: ((answer: HappierInputPickerResult) => void) | undefined;
    let signal: AbortSignal | undefined;
    const port: HappierInputPickerPort = {
      describe: field => field.inputType ? { label: 'Browse…', accessibilityLabel: 'Browse for Repository' } : null,
      pick: request => {
        signal = request.signal;
        return new Promise(resolve => { settle = resolve; });
      },
    };
    const { mount, browse, onChange } = mountForm(port, { note: 'Release', repository: 'happier' });
    await choose(browse());
    const context = createSurfaceContext();
    await mount.render(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <HappierInputPickerProvider port={port}>
        <Form hints={{ ...hints, fields: [hints.fields![0]!, { ...repositoryField,
          options: repositoryField.options.map(option => ({ ...option })),
        }] }} value={{ note: 'Release', repository: 'happier' }} onChange={onChange} onSubmit={() => undefined} />
      </HappierInputPickerProvider>
    </PluginUiProvider>);
    expect(signal?.aborted).toBe(false);
    await mount.render(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <HappierInputPickerProvider port={port}>
        <Form hints={{ ...hints, fields: [hints.fields![0]!, { ...repositoryField,
          options: [{ value: 'happier', label: 'happier' }],
        }] }} value={{ note: 'Release', repository: 'happier' }} onChange={onChange} onSubmit={() => undefined} />
      </HappierInputPickerProvider>
    </PluginUiProvider>);
    expect(signal?.aborted).toBe(true);
    await act(async () => { settle?.({ status: 'selected', value: 'website' }); });
    expect(onChange).not.toHaveBeenCalled();
    mount.unmount();
  });
  it('cancels a retired consumer context without changing its saved value and returns focus', async () => {
    let settle: ((answer: HappierInputPickerResult) => void) | undefined;
    let signal: AbortSignal | undefined;
    // The public host presentation port is this package's genuine boundary.
    const port: HappierInputPickerPort = {
      describe: field => field.inputType ? { label: 'Browse…', accessibilityLabel: 'Browse for Repository' } : null,
      pick: request => {
        signal = request.signal;
        return new Promise(resolve => { settle = resolve; });
      },
    };
    const { mount, browse, onChange } = mountForm(port, { note: 'Release', repository: 'happier' });
    await choose(browse());
    const pickerField = document.createElement('input');
    document.body.appendChild(pickerField);
    pickerField.focus();
    pickerField.remove();
    const context = createSurfaceContext();
    await mount.render(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <HappierInputPickerProvider port={{ ...port }}>
        <Form hints={hints} value={{ note: 'Release', repository: 'happier' }} onChange={onChange} onSubmit={() => undefined} />
      </HappierInputPickerProvider>
    </PluginUiProvider>);
    expect(signal?.aborted).toBe(true);
    await act(async () => { settle?.({ status: 'selected', value: 'website' }); });
    expect(onChange).not.toHaveBeenCalled();
    expect(mount.container.ownerDocument.activeElement).toBe(browse());
    mount.unmount();
  });
  it('offers the admitted picker beneath a typed field and writes only its validated answer', async () => {
    const harness = createHarness();
    const { mount, browse, onChange } = mountForm(harness.port, { note: 'Release', repository: 'happier' });
    expect(browse()).not.toBeNull();

    harness.answer({ kind: 'completed', input: 'website' });
    await choose(browse());

    expect(harness.opened()).toBe(1);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({ note: 'Release', repository: 'website' });
    // Focus comes back to the control that opened the picker.
    expect(mount.container.ownerDocument.activeElement).toBe(browse());
    mount.unmount();
  });

  it('keeps every entered value when the picker is cancelled', async () => {
    const harness = createHarness();
    const { mount, browse, onChange } = mountForm(harness.port, { note: 'Release', repository: 'happier' });

    harness.answer({ kind: 'cancelled' });
    await choose(browse());

    expect(onChange).not.toHaveBeenCalled();
    expect(mount.container.querySelector('[role="alert"]')).toBeNull();
    expect(mount.container.querySelector<HTMLInputElement>('input[aria-label="Note"]')?.value).toBe('Release');
    mount.unmount();
  });

  it('shows a value the type refuses as this field’s error and does not write it', async () => {
    const harness = createHarness();
    const { mount, browse, onChange } = mountForm(harness.port, { note: 'Release', repository: 'happier' });

    // Not one of the choices this field offers: the same check an agent's value meets.
    harness.answer({ kind: 'completed', input: 'someone-elses-repo' });
    await choose(browse());

    expect(onChange).not.toHaveBeenCalled();
    const radio = mount.container.querySelector<HTMLElement>('[role="radio"]');
    expect(radio?.getAttribute('aria-invalid')).toBe('true');
    const issue = mount.container.ownerDocument.getElementById(radio!.getAttribute('aria-errormessage')!);
    expect(issue?.textContent).toBe('Refused: input_type_option_invalid');
    mount.unmount();
  });

  it('refuses an answer from a plugin that was replaced while its picker was open', async () => {
    const harness = createHarness();
    const { mount, browse, onChange } = mountForm(harness.port, { note: 'Release', repository: 'happier' });

    harness.answer({ kind: 'completed', input: 'website' });
    const replaced = { ...declared, occurrenceId: 'occurrence-2' };
    const port = harness.port;
    const replacing: HappierInputPickerPort = {
      describe: port.describe,
      pick: async (request) => {
        const pending = port.pick(request);
        harness.setType(replaced);
        return pending;
      },
    };
    await mount.render(
      <PluginUiProvider hostApi={createHostApiStub(createSurfaceContext())} context={createSurfaceContext()}>
        <HappierInputPickerProvider port={replacing}>
          <Form hints={hints} value={{ note: 'Release', repository: 'happier' }} onChange={onChange} onSubmit={() => undefined} />
        </HappierInputPickerProvider>
      </PluginUiProvider>,
    );
    await choose(browse());

    expect(onChange).not.toHaveBeenCalled();
    expect(mount.container.textContent).toContain('Refused: input_type_retired');
    mount.unmount();
  });

  it('keeps an uninstalled type’s saved value and offers no picker; headless use needs none', async () => {
    const harness = createHarness();
    harness.setType(null);
    const uninstalled = mountForm(harness.port, { note: 'Release', repository: 'website' });
    expect(uninstalled.browse()).toBeNull();
    const checked = uninstalled.mount.container.querySelector('[role="radio"][aria-checked="true"]');
    expect(checked?.textContent).toContain('website');
    uninstalled.mount.unmount();

    // No host port at all (an agent or a host without pickers): the same field, choices and value.
    const headless = mountForm(null, { note: 'Release', repository: 'website' });
    expect(headless.browse()).toBeNull();
    expect(headless.mount.container.querySelectorAll('[role="radio"]')).toHaveLength(2);
    headless.mount.unmount();
  });
});
