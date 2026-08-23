import { act, useState } from 'react';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { ActionInputHints } from '@happier-dev/plugin-sdk/actions';

import { HappierSelect, HappierValidationMessage } from '../presentation/form/Fields.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext, SURFACE_THEME_FIXTURE } from '../surfaceFixture.testSupport.js';
import { Form } from './index.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import type { FormProps } from './Form.js';

const hints: ActionInputHints = {
  title: 'Connect provider',
  description: 'Configure the provider connection.',
  submitLabel: 'Connect',
  fields: [
    { path: 'name', title: 'Name', widget: 'text', required: true },
    { path: 'token', title: 'Token', widget: 'secret', required: true },
    {
      path: 'mode',
      title: 'Mode',
      widget: 'select',
      options: [
        { value: 'poll', label: 'Polling' },
        { value: 'webhook', label: 'Webhook' },
      ],
    },
    {
      path: 'endpoint',
      title: 'Endpoint',
      widget: 'url',
      visibleWhen: { op: 'eq', path: 'mode', value: 'webhook' },
      requiredWhen: { op: 'eq', path: 'mode', value: 'webhook' },
    },
    { path: 'enabled', title: 'Enabled', widget: 'boolean' },
  ],
};

const defaultChromeHints: ActionInputHints = { fields: [] };

function mountForm(element: React.ReactElement, context = createSurfaceContext()) {
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      {element}
    </PluginUiProvider>,
  );
}

describe('canonical Action Form presentation', () => {
  it('resolves direct field chrome through the plugin catalog', () => {
    const context = createSurfaceContext({
      translations: {
        'acme.search': 'Rechercher',
        'acme.filter': 'Filtrer par titre',
      },
    });
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <Form.TextField
          label="Search"
          labelKey="acme.search"
          placeholder="Filter by title"
          placeholderKey="acme.filter"
          value=""
          onChange={() => undefined}
        />
      </PluginUiProvider>,
    );

    expect(mount.container.querySelector('input')?.getAttribute('aria-label')).toBe('Rechercher');
    expect(mount.container.querySelector('input')?.getAttribute('placeholder')).toBe('Filtrer par titre');
    mount.unmount();
  });

  it('accepts only host-pre-resolved field options and exposes no option-loading callback', () => {
    expectTypeOf<FormProps>().not.toHaveProperty('resolveOptions');
  });

  it('preserves the host-selected live-region policy for validation feedback', () => {
    const mount = mountThroughReactNativeWeb(
      <HappierValidationMessage
        message="Unable to save"
        accessibilityLiveRegion="polite"
        theme={SURFACE_THEME_FIXTURE}
      />,
    );

    expect(mount.container.querySelector('[role="alert"]')?.getAttribute('aria-live')).toBe('polite');
    mount.unmount();
  });

  it('renders localized host-owned default submit and cancel chrome with accessible names', () => {
    const context = createSurfaceContext({
      locale: 'es',
      translations: {
        'happier.plugin-ui.form.submit': 'Enviar',
        'happier.plugin-ui.form.cancel': 'Cancelar',
      },
    });
    const mount = mountForm(
      <Form
        hints={defaultChromeHints}
        value={{}}
        onChange={() => undefined}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
      context,
    );

    const buttons = [...mount.container.querySelectorAll<HTMLElement>('[role="button"]')];
    const submit = buttons.find((node) => node.textContent === 'Enviar');
    const cancel = buttons.find((node) => node.textContent === 'Cancelar');

    expect(submit, 'expected the localized submit action').toBeDefined();
    expect(cancel, 'expected the localized cancel action').toBeDefined();
    expect(submit?.getAttribute('aria-label') ?? submit?.textContent).toBe('Enviar');
    expect(cancel?.getAttribute('aria-label') ?? cancel?.textContent).toBe('Cancelar');
    mount.unmount();
  });

  it('falls back to English framework action labels when the host map has no localized defaults', () => {
    const mount = mountForm(
      <Form
        hints={defaultChromeHints}
        value={{}}
        onChange={() => undefined}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(mount.container.textContent).toContain('Submit');
    expect(mount.container.textContent).toContain('Cancel');
    mount.unmount();
  });

  it('keeps explicit author action labels ahead of localized framework defaults', () => {
    const context = createSurfaceContext({
      locale: 'es',
      translations: {
        'happier.plugin-ui.form.submit': 'Enviar',
        'happier.plugin-ui.form.cancel': 'Cancelar',
      },
    });
    const props = {
      hints: { ...defaultChromeHints, submitLabel: 'Save note' },
      value: {},
      onChange: () => undefined,
      onSubmit: () => undefined,
      onCancel: () => undefined,
      cancelLabel: 'Discard note',
    } satisfies FormProps;
    const mount = mountForm(<Form {...props} />, context);

    expect(mount.container.textContent).toContain('Save note');
    expect(mount.container.textContent).toContain('Discard note');
    expect(mount.container.textContent).not.toContain('Enviar');
    expect(mount.container.textContent).not.toContain('Cancelar');
    mount.unmount();
  });

  it('uses canonical predicates and keeps secret input masked', async () => {
    let value: Record<string, unknown> = { mode: 'poll', enabled: true };
    const onChange = vi.fn((next: Record<string, unknown>) => { value = next; });
    const mount = mountForm(<Form hints={hints} value={value} onChange={onChange} onSubmit={() => undefined} />);

    expect(mount.container.querySelector('[role="form"]')).not.toBeNull();
    expect(mount.container.textContent).not.toContain('Endpoint');
    const secret = mount.container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(secret).not.toBeNull();

    const webhook = [...mount.container.querySelectorAll<HTMLElement>('[role="radio"]')]
      .find((node) => node.textContent === 'Webhook');
    await act(async () => { webhook?.click(); });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ mode: 'webhook' }));

    await mount.render(
      <PluginUiProvider hostApi={createHostApiStub(createSurfaceContext())} context={createSurfaceContext()}>
        <Form hints={hints} value={value} onChange={onChange} onSubmit={() => undefined} />
      </PluginUiProvider>,
    );
    expect(mount.container.textContent).toContain('Endpoint');
    expect(mount.container.querySelector('[aria-required="true"]')).not.toBeNull();
    mount.unmount();
  });

  it('names a titled public form for assistive technology', () => {
    const mount = mountForm(
      <Form hints={hints} value={{}} onChange={() => undefined} onSubmit={() => undefined} />,
    );

    expect(mount.container.querySelector('[role="form"]')?.getAttribute('aria-label')).toBe('Connect provider');
    mount.unmount();
  });

  it('submits normalized current input and exposes boolean switch semantics', async () => {
    const value = { name: 'Alerts', token: 'secret', mode: 'poll', enabled: true };
    const onSubmit = vi.fn(async () => undefined);
    const mount = mountForm(<Form hints={hints} value={value} onChange={() => undefined} onSubmit={onSubmit} />);

    expect(mount.container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    const submit = [...mount.container.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((node) => node.textContent === 'Connect');
    await act(async () => { submit?.click(); });
    expect(onSubmit).toHaveBeenCalledWith(value);

    mount.unmount();
  });

  it('uses one pending form fact for a returned submit promise and keeps cancellation reachable', async () => {
    let settle: () => void = () => {};
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    const onSubmit = vi.fn(() => pending);
    const onCancel = vi.fn();
    const value = { name: 'Alerts', token: 'secret', mode: 'poll', enabled: true };
    const mount = mountForm(<Form
      hints={hints}
      value={value}
      onChange={() => undefined}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />);

    const name = mount.container.querySelector<HTMLInputElement>('input[aria-label="Name"]');
    const option = mount.container.querySelector<HTMLElement>('[role="radio"]');
    const submit = [...mount.container.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((node) => node.textContent === 'Connect');
    const cancel = [...mount.container.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((node) => node.textContent === 'Cancel');

    await act(async () => { submit?.click(); });

    expect(onSubmit).toHaveBeenCalledWith(value);
    expect(mount.container.querySelector('[role="form"]')?.getAttribute('aria-busy')).toBe('true');
    expect(name?.getAttribute('aria-disabled')).toBe('true');
    expect(option?.getAttribute('aria-disabled')).toBe('true');
    expect(submit?.getAttribute('aria-busy')).toBe('true');
    expect(cancel?.getAttribute('aria-disabled')).not.toBe('true');

    await act(async () => { cancel?.click(); });
    expect(onCancel).toHaveBeenCalledOnce();

    await act(async () => {
      settle();
      await pending;
    });

    expect(mount.container.querySelector('[role="form"]')?.getAttribute('aria-busy')).not.toBe('true');
    expect(name?.getAttribute('aria-disabled')).not.toBe('true');
    expect(option?.getAttribute('aria-disabled')).not.toBe('true');
    mount.unmount();
  });

  it('treats an explicit busy declaration as the same pending form fact without disabling cancellation', () => {
    const mount = mountForm(<Form
      hints={hints}
      value={{ name: 'Alerts', token: 'secret', mode: 'poll', enabled: true }}
      onChange={() => undefined}
      onSubmit={() => undefined}
      onCancel={() => undefined}
      busy
    />);

    const name = mount.container.querySelector<HTMLInputElement>('input[aria-label="Name"]');
    const option = mount.container.querySelector<HTMLElement>('[role="radio"]');
    const cancel = [...mount.container.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((node) => node.textContent === 'Cancel');

    expect(mount.container.querySelector('[role="form"]')?.getAttribute('aria-busy')).toBe('true');
    expect(name?.getAttribute('aria-disabled')).toBe('true');
    expect(option?.getAttribute('aria-disabled')).toBe('true');
    expect(cancel?.getAttribute('aria-disabled')).not.toBe('true');
    mount.unmount();
  });

  it('links invalid text, selection, and toggle controls to their live issue feedback', () => {
    const mount = mountForm(<Form
      hints={hints}
      value={{ name: '', token: '', mode: 'poll', enabled: true }}
      onChange={() => undefined}
      onSubmit={() => undefined}
      issues={{
        name: 'Enter a name.',
        mode: 'Choose how to connect.',
        enabled: 'Confirm whether the provider is enabled.',
      }}
    />);

    const controls = [
      mount.container.querySelector<HTMLElement>('input[aria-label="Name"]'),
      mount.container.querySelector<HTMLElement>('[role="radio"]'),
      mount.container.querySelector<HTMLElement>('[role="switch"]'),
    ];
    for (const control of controls) {
      expect(control, 'expected an invalid field control').not.toBeNull();
      expect(control?.getAttribute('aria-invalid')).toBe('true');
      const issueId = control?.getAttribute('aria-errormessage');
      expect(issueId).toBeTruthy();
      const issue = mount.container.ownerDocument.getElementById(issueId!);
      expect(issue?.getAttribute('role')).toBe('alert');
      expect(issue?.getAttribute('aria-live')).toBe('polite');
    }

    mount.unmount();
  });

  it('draws visible focus chrome around a Toggle', async () => {
    const mount = mountForm(
      <Form.Toggle label="Enable sync" value={false} onChange={() => undefined} />,
    );
    const toggle = mount.container.querySelector<HTMLElement>('[role="switch"]');
    expect(toggle).not.toBeNull();
    const unfocusedBorder = getComputedStyle(toggle!).borderTopColor;

    await act(async () => { toggle?.focus(); });

    expect(getComputedStyle(toggle!).borderTopColor).not.toBe(unfocusedBorder);
    mount.unmount();
  });

  it('gives a single-select radiogroup one shared roving tab stop', async () => {
    function SelectHarness() {
      const [value, setValue] = useState('poll');
      return (
        <HappierSelect
          label="Connection mode"
          options={[
            { value: 'poll', label: 'Polling' },
            { value: 'webhook', label: 'Webhook' },
          ]}
          value={value}
          onChange={(next) => {
            if (typeof next === 'string') setValue(next);
          }}
          theme={SURFACE_THEME_FIXTURE}
        />
      );
    }

    const mount = mountThroughReactNativeWeb(<SelectHarness />);
    let radios = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="radio"]'));
    expect(radios.map((radio) => radio.getAttribute('tabindex'))).toEqual(['0', '-1']);

    await act(async () => {
      radios[0]?.focus();
      radios[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });

    radios = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="radio"]'));
    expect(document.activeElement).toBe(radios[1]);
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(radios.map((radio) => radio.getAttribute('tabindex'))).toEqual(['-1', '0']);
    mount.unmount();
  });

  it('does not give object-valued standalone choices duplicate React keys', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mount = mountThroughReactNativeWeb(
      <HappierSelect
        label="Connected account"
        options={[
          { value: { accountId: 'one' }, label: 'First account' },
          { value: { accountId: 'two' }, label: 'Second account' },
        ]}
        value={undefined}
        onChange={() => undefined}
        theme={SURFACE_THEME_FIXTURE}
      />,
    );

    try {
      expect(error.mock.calls.some((call) => call.some((value) => String(value).includes('same key')))).toBe(false);
    } finally {
      mount.unmount();
      error.mockRestore();
    }
  });

  it('keeps exact Connected Account option values semantically selected and captions accessible on RNW', () => {
    const account = {
      service: { pluginId: 'com.acme.accounts', localId: 'service' },
      accountId: 'account-1',
    };
    const accountHints: ActionInputHints = {
      fields: [{
        path: 'credentialRef',
        title: 'Connected account',
        widget: 'select',
        options: [{
          value: account,
          label: 'Work account',
          description: 'Connected through Acme',
        }],
      }],
    };
    const mount = mountForm(<Form
      hints={accountHints}
      value={{ credentialRef: { ...account, service: { ...account.service } } }}
      onChange={() => undefined}
      onSubmit={() => undefined}
    />);

    const option = [...mount.container.querySelectorAll<HTMLElement>('[role="radio"]')]
      .find((node) => node.textContent?.includes('Work account'));
    expect(option?.getAttribute('aria-checked')).toBe('true');
    expect(option?.getAttribute('aria-label')).toBe('Work account: Connected through Acme');
    mount.unmount();
  });

  it('lets a required max-one multiselect replace its selection instead of deadlocking', async () => {
    function RequiredEngineSelection() {
      const [value, setValue] = useState<Record<string, unknown>>({ engineIds: ['claude'] });
      return (
        <Form
          hints={{
            fields: [{
              path: 'engineIds',
              title: 'Review engines',
              widget: 'multiselect',
              required: true,
              maxSelections: 1,
              options: [
                { value: 'claude', label: 'Claude' },
                { value: 'codex', label: 'Codex' },
              ],
            }],
          }}
          value={value}
          onChange={setValue}
          onSubmit={() => undefined}
        />
      );
    }

    const mount = mountForm(<RequiredEngineSelection />);
    const claude = [...mount.container.querySelectorAll<HTMLElement>('[role="checkbox"]')]
      .find((option) => option.textContent?.includes('Claude'));
    const codex = [...mount.container.querySelectorAll<HTMLElement>('[role="checkbox"]')]
      .find((option) => option.textContent?.includes('Codex'));

    expect(claude?.getAttribute('aria-checked')).toBe('true');
    expect(claude?.getAttribute('aria-disabled')).toBe('true');
    expect(codex?.getAttribute('aria-disabled')).not.toBe('true');

    await act(async () => { codex?.click(); });

    expect(claude?.getAttribute('aria-checked')).toBe('false');
    expect(codex?.getAttribute('aria-checked')).toBe('true');
    mount.unmount();
  });

  it('scales text-entry metrics with the projected 200% text preference', () => {
    const context = createSurfaceContext({ textScale: 2 });
    const mount = mountForm(
      <Form.TextField label="Name" value="" onChange={() => undefined} testID="scaled-field" />,
      context,
    );

    const input = mount.container.querySelector<HTMLInputElement>('[data-testid="scaled-field"]');
    expect(input?.style.fontSize).toBe(`${context.theme.typography.body.fontSize * 2}px`);
    expect(input?.style.lineHeight).toBe(`${context.theme.typography.body.lineHeight * 2}px`);
    mount.unmount();
  });
});

describe('plugin-ui text entry behaviour', () => {
  function mountTextField(element: React.ReactElement) {
    return mountForm(element);
  }

  function fieldOf(mount: ReturnType<typeof mountForm>, testID: string) {
    return mount.container.querySelector<HTMLInputElement>(`[data-testid="${testID}"]`);
  }

  it('keeps prose entry defaults for an ordinary field and quiet defaults for a secret', () => {
    const mount = mountTextField(
      <>
        <Form.TextField label="Name" value="" onChange={() => undefined} testID="prose-field" />
        <Form.TextField label="Token" value="" secure onChange={() => undefined} testID="secret-field" />
      </>,
    );

    // The derived defaults are the protected behaviour: an author who declares
    // nothing keeps prose capitalization, and a secret is never capitalized or
    // corrected even when the author declares nothing either.
    expect(fieldOf(mount, 'prose-field')?.getAttribute('autocapitalize')).toBe('sentences');
    expect(fieldOf(mount, 'prose-field')?.getAttribute('autocorrect')).toBe('on');
    expect(fieldOf(mount, 'secret-field')?.getAttribute('autocapitalize')).toBe('none');
    expect(fieldOf(mount, 'secret-field')?.getAttribute('autocorrect')).toBe('off');
    mount.unmount();
  });

  it('lets a search field own its capitalization and correction', () => {
    const mount = mountTextField(
      <Form.TextField
        label="Search"
        value=""
        onChange={() => undefined}
        autoCapitalize="none"
        autoCorrect={false}
        testID="search-field"
      />,
    );

    expect(fieldOf(mount, 'search-field')?.getAttribute('autocapitalize')).toBe('none');
    expect(fieldOf(mount, 'search-field')?.getAttribute('autocorrect')).toBe('off');
    mount.unmount();
  });

  it('places the caret where the author says it is rather than at the end of the value', () => {
    const mount = mountTextField(
      <Form.TextField
        label="Search"
        value="happier"
        onChange={() => undefined}
        selection={{ start: 2, end: 5 }}
        testID="search-field"
      />,
    );

    const input = fieldOf(mount, 'search-field');
    expect(input?.selectionStart).toBe(2);
    expect(input?.selectionEnd).toBe(5);
    mount.unmount();
  });

  it('submits a search on Enter but stays quiet while an IME composition is open', async () => {
    const onSubmitEditing = vi.fn();
    const mount = mountTextField(
      <Form.TextField
        label="Search"
        value="happier"
        onChange={() => undefined}
        onSubmitEditing={onSubmitEditing}
        testID="search-field"
      />,
    );
    const input = fieldOf(mount, 'search-field');

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(onSubmitEditing).not.toHaveBeenCalled();

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onSubmitEditing).toHaveBeenCalledTimes(1);
    mount.unmount();
  });

  it('reports the reader-moved caret as a portable selection, not a host event', async () => {
    const onSelectionChange = vi.fn();
    const mount = mountTextField(
      <Form.TextField
        label="Search"
        value="happier"
        onChange={() => undefined}
        onSelectionChange={onSelectionChange}
        testID="search-field"
      />,
    );
    const input = fieldOf(mount, 'search-field');

    await act(async () => {
      input?.focus();
      input?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      input?.setSelectionRange(1, 3);
      input?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    // The author receives the caret itself; the platform's event never leaks.
    expect(onSelectionChange).toHaveBeenCalledWith({ start: 1, end: 3 });
    mount.unmount();
  });
});
