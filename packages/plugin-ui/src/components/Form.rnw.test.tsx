import { act, useState } from 'react';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { ActionInputHints } from '@happier-dev/plugin-sdk/actions';

import { HAPPIER_FIELD_BOX_METRICS } from '../presentation/form/FieldBox.js';
import { HappierSelect, HappierValidationMessage } from '../presentation/form/Fields.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext, SURFACE_THEME_FIXTURE } from '../surfaceFixture.testSupport.js';
import { Form } from './index.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import {
  PluginUiPresentationHostProviderInternal,
  type PluginUiPresentationHost,
} from '../presentationHost/context.js';
import type { FormProps } from './Form.js';
import { HappierUiPaletteProvider } from '../environment/context.js';
import type { HappierUiPalette } from '../environment/types.js';

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

  it('associates field descriptions with text, selection, and toggle controls', () => {
    const mount = mountForm(
      <>
        <Form.Field label="Name" description="Shown to collaborators.">
          <Form.TextField label="Name" value="" onChange={() => undefined} />
        </Form.Field>
        <Form.Field label="Mode" description="Controls refresh behavior.">
          <Form.Select
            label="Mode"
            options={[{ value: 'poll', label: 'Polling' }]}
            value="poll"
            onChange={() => undefined}
          />
        </Form.Field>
        <Form.Field label="Enabled" description="Allows background refresh.">
          <Form.Toggle label="Enabled" value onChange={() => undefined} />
        </Form.Field>
      </>,
    );

    for (const control of [
      mount.container.querySelector<HTMLElement>('input[aria-label="Name"]'),
      mount.container.querySelector<HTMLElement>('[role="radiogroup"]'),
      mount.container.querySelector<HTMLElement>('[role="switch"]'),
    ]) {
      const descriptionId = control?.getAttribute('aria-describedby');
      expect(descriptionId).toBeTruthy();
      expect(mount.container.ownerDocument.getElementById(descriptionId!)?.textContent).not.toBe('');
    }
    mount.unmount();
  });

  it('draws visible focus chrome around a Toggle', async () => {
    const mount = mountForm(
      <Form.Toggle label="Enable sync" value={false} onChange={() => undefined} />,
    );
    const toggle = mount.container.querySelector<HTMLElement>('[role="switch"]');
    expect(toggle).not.toBeNull();
    // The ring rides the drawn track (the switch's first child), not the larger hit box around it.
    const track = toggle!.firstElementChild as HTMLElement;
    expect(getComputedStyle(track).outlineStyle).not.toBe('solid');

    await act(async () => { toggle?.focus(); });

    expect(getComputedStyle(track).outlineStyle).toBe('solid');
    expect(getComputedStyle(track).outlineOffset).toBe('2px');
    // One ring: the hit box drops the browser's own.
    expect(getComputedStyle(toggle!).outlineStyle).toBe('none');
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

  it('exposes Select requiredness on the owning group', () => {
    const mount = mountThroughReactNativeWeb(
      <HappierSelect
        label="Connection mode"
        required
        options={[{ value: 'poll', label: 'Polling' }]}
        value="poll"
        onChange={() => undefined}
        theme={SURFACE_THEME_FIXTURE}
      />,
    );

    expect(mount.container.querySelector('[role="radiogroup"]')?.getAttribute('aria-required')).toBe('true');
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

  it('rejects semantically duplicate options through the canonical comparator', () => {
    expect(() => mountThroughReactNativeWeb(
      <HappierSelect
        label="Connected account"
        options={[
          {
            value: { service: { pluginId: 'acme', localId: 'github' }, accountId: 'one' },
            label: 'First account',
          },
          {
            value: { service: { pluginId: 'acme', localId: 'github' }, accountId: 'one' },
            label: 'Duplicate account',
          },
        ]}
        value={undefined}
        onChange={() => undefined}
        isEqual={(left, right) => left.accountId === right.accountId
          && left.service.pluginId === right.service.pluginId
          && left.service.localId === right.service.localId}
        theme={SURFACE_THEME_FIXTURE}
      />,
    )).toThrow(/duplicate values/u);
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

  it('keeps the effective selection cap at or above the required floor', async () => {
    const changes = vi.fn();
    const mount = mountForm(
      <HappierSelect
        label="Review engines"
        multiple
        required
        minimumSelections={2}
        maxSelections={1}
        options={[
          { value: 'claude', label: 'Claude' },
          { value: 'codex', label: 'Codex' },
          { value: 'gemini', label: 'Gemini' },
        ]}
        value={['claude', 'codex']}
        onChange={changes}
        theme={SURFACE_THEME_FIXTURE}
      />,
    );
    const gemini = [...mount.container.querySelectorAll<HTMLElement>('[role="checkbox"]')]
      .find((option) => option.textContent?.includes('Gemini'));

    await act(async () => { gemini?.click(); });

    expect(changes).toHaveBeenCalledWith(['codex', 'gemini']);
    mount.unmount();
  });

  it('uses one semantic selection set for a required multiselect with duplicate controlled values', async () => {
    const changes = vi.fn();
    const mount = mountForm(
      <HappierSelect
        label="Review engines"
        multiple
        required
        options={[{ value: 'claude', label: 'Claude' }]}
        value={['claude', 'claude']}
        onChange={changes}
        theme={SURFACE_THEME_FIXTURE}
      />,
    );
    const claude = mount.container.querySelector<HTMLElement>('[role="checkbox"]');

    expect(claude?.getAttribute('aria-checked')).toBe('true');
    expect(claude?.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { claude?.click(); });
    expect(changes).not.toHaveBeenCalled();
    mount.unmount();
  });

  it('enforces a multi-selection floor against semantic values rather than duplicate entries', async () => {
    const changes = vi.fn();
    const mount = mountForm(
      <HappierSelect
        label="Review engines"
        multiple
        minimumSelections={2}
        options={[
          { value: 'claude', label: 'Claude' },
          { value: 'codex', label: 'Codex' },
        ]}
        value={['claude', 'claude', 'codex']}
        onChange={changes}
        theme={SURFACE_THEME_FIXTURE}
      />,
    );
    const options = [...mount.container.querySelectorAll<HTMLElement>('[role="checkbox"]')];

    expect(options.every((option) => option.getAttribute('aria-disabled') === 'true')).toBe(true);
    await act(async () => { options[0]?.click(); });
    expect(changes).not.toHaveBeenCalled();
    mount.unmount();
  });

  it('deduplicates custom-equal selections before floor, cap, and emission while preserving unknown values', async () => {
    type Choice = Readonly<{ id: string; revision: number }>;
    const changes = vi.fn();
    const stale: Choice = { id: 'stale', revision: 1 };
    const firstA: Choice = { id: 'a', revision: 1 };
    const retainedA: Choice = { id: 'a', revision: 2 };
    const b: Choice = { id: 'b', revision: 1 };
    const mount = mountForm(
      <HappierSelect<Choice>
        label="Review engines"
        multiple
        minimumSelections={2}
        maxSelections={3}
        options={[
          { value: retainedA, label: 'A' },
          { value: b, label: 'B' },
        ]}
        value={[stale, firstA, retainedA]}
        isEqual={(left, right) => left.id === right.id}
        keyForOption={(option) => option.value.id}
        onChange={changes}
        theme={SURFACE_THEME_FIXTURE}
      />,
    );
    const optionB = [...mount.container.querySelectorAll<HTMLElement>('[role="checkbox"]')]
      .find((option) => option.textContent?.includes('B'));

    await act(async () => { optionB?.click(); });

    expect(changes).toHaveBeenCalledWith([stale, retainedA, b]);
    mount.unmount();
  });

  it('exposes a zero optional selection cap as unavailable choices', () => {
    const changes = vi.fn();
    const mount = mountForm(
      <HappierSelect
        label="Review engines"
        multiple
        maxSelections={0}
        options={[{ value: 'claude', label: 'Claude' }]}
        value={[]}
        onChange={changes}
        theme={SURFACE_THEME_FIXTURE}
      />,
    );
    const claude = mount.container.querySelector<HTMLElement>('[role="checkbox"]');

    expect(claude?.getAttribute('aria-disabled')).toBe('true');
    claude?.click();
    expect(changes).not.toHaveBeenCalled();
    mount.unmount();
  });

  it('clears a stale controlled selection when the selection cap is zero', async () => {
    const changes = vi.fn();
    const mount = mountForm(
      <HappierSelect
        label="Review engines"
        multiple
        maxSelections={0}
        options={[
          { value: 'claude', label: 'Claude' },
          { value: 'codex', label: 'Codex' },
        ]}
        value={['claude', 'codex']}
        onChange={changes}
        theme={SURFACE_THEME_FIXTURE}
      />,
    );
    const claude = [...mount.container.querySelectorAll<HTMLElement>('[role="checkbox"]')]
      .find((option) => option.textContent?.includes('Claude'));

    await act(async () => { claude?.click(); });

    expect(changes).toHaveBeenCalledWith([]);
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

describe('standalone Select presentation', () => {
  function mountWithMenuHost(element: React.ReactElement) {
    const context = createSurfaceContext();
    const host = {
      renderMarkdown: () => null,
      renderCodeBlock: () => null,
      renderIcon: () => null,
      renderPopover: (input: Parameters<PluginUiPresentationHost['renderPopover']>[0]) => (
        input.open ? input.content({ requestClose: () => input.onRequestClose(), maxHeight: 400 }) : null
      ),
    } as unknown as PluginUiPresentationHost;
    return mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal host={host}>{element}</PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
    );
  }
  const orderOptions = [
    { value: 'newest', label: 'Newest' },
    { value: 'oldest', label: 'Oldest' },
    { value: 'smart', label: 'Smart' },
  ] as const;

  it('names a standalone inline Select visibly, and a Select inside a Field only once', () => {
    const standalone = mountForm(
      <Form.Select label="Order" value="newest" options={orderOptions} onChange={() => undefined} />,
    );
    // A reader who cannot tell a source tile from a state tile needs the name
    // on screen, not only in the accessibility tree.
    expect(standalone.container.textContent).toContain('Order');
    standalone.unmount();

    const fielded = mountForm(
      <Form.Field label="Order">
        <Form.Select label="Order" value="newest" options={orderOptions} onChange={() => undefined} />
      </Form.Field>,
    );
    expect(fielded.container.textContent?.match(/Order/gu)).toHaveLength(1);
    fielded.unmount();
  });

  it('presents a menu Select as one labelled trigger that opens the shared menu', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<string>('newest');
      return (
        <Form.Select
          label="Order"
          presentation="menu"
          value={value}
          options={orderOptions}
          onChange={(next) => { onChange(next); setValue(next as string); }}
        />
      );
    }
    const mount = mountWithMenuHost(<Harness />);

    // Closed: one compact trigger that states the current choice, no tiles.
    expect(mount.container.querySelectorAll('[role="radio"], [role="menuitemradio"]')).toHaveLength(0);
    const trigger = mount.container.querySelector<HTMLElement>('[aria-haspopup="menu"]');
    expect(trigger?.textContent).toContain('Order');
    expect(trigger?.textContent).toContain('Newest');

    await act(async () => { trigger?.click(); });
    const items = [...mount.container.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);

    await act(async () => { items[2]?.click(); });
    expect(onChange).toHaveBeenLastCalledWith('smart');
    expect(mount.container.querySelector('[aria-haspopup="menu"]')?.textContent).toContain('Smart');
    mount.unmount();
  });

  it('keeps a multi-select menu open while toggling and enforces the same selection floor', async () => {
    function Harness() {
      const [value, setValue] = useState<readonly string[]>(['github']);
      return (
        <Form.Select
          label="Source"
          presentation="menu"
          multiple
          minimumSelections={1}
          value={value}
          options={[{ value: 'github', label: 'GitHub' }, { value: 'sentry', label: 'Sentry' }]}
          onChange={(next) => { setValue(next as readonly string[]); }}
        />
      );
    }
    const mount = mountWithMenuHost(<Harness />);
    await act(async () => { mount.container.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.click(); });
    let items = [...mount.container.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')];
    // The last remaining selection under a floor cannot be removed — the same
    // rule the inline presentation enforces, from the same owner.
    expect(items[0]?.getAttribute('aria-disabled')).toBe('true');

    await act(async () => { items[1]?.click(); });
    items = [...mount.container.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')];
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'true']);
    expect(mount.container.querySelector('[aria-haspopup="menu"]')?.textContent).toContain('2');
    mount.unmount();
  });
});

describe('shared control visuals (D6)', () => {
  const HOST_PALETTE: HappierUiPalette = {
    page: '#fafafa',
    sheet: '#ffffff',
    sheetBorder: '#e0e0e0',
    rowDivider: '#eeeeee',
    groupDivider: '#0d0e0f',
    controlBorder: '#abcdef',
    fieldBackground: '#fdfdfd',
    placeholder: '#999999',
    selection: '#111111',
    switchTrackOn: '#123456',
    switchTrackOff: '#654321',
    switchThumb: '#fedcba',
    segmentTrack: '#e1e1e1',
    segmentThumb: '#fefefe',
    navigationSelected: '#e8e8e8',
    navigationHover: '#efefef',
  };

  const fieldOrderOptions = [
    { value: 'newest', label: 'Newest' },
    { value: 'oldest', label: 'Oldest' },
    { value: 'smart', label: 'Smart' },
  ] as const;

  function mountWithPalette(element: React.ReactElement) {
    const context = createSurfaceContext();
    const host = {
      renderMarkdown: () => null,
      renderCodeBlock: () => null,
      renderIcon: () => null,
      renderPopover: (input: Parameters<PluginUiPresentationHost['renderPopover']>[0]) => (
        input.open ? input.content({ requestClose: () => input.onRequestClose(), maxHeight: 400 }) : null
      ),
    } as unknown as PluginUiPresentationHost;
    return mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal host={host}>
          <HappierUiPaletteProvider palette={HOST_PALETTE}>{element}</HappierUiPaletteProvider>
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
    );
  }

  it('draws a Toggle with the shared switch geometry in the host switch colours', async () => {
    function Harness() {
      const [value, setValue] = useState(true);
      return <Form.Toggle label="Enable sync" value={value} onChange={setValue} />;
    }
    const mount = mountWithPalette(<Harness />);
    const toggle = mount.container.querySelector<HTMLElement>('[role="switch"]');
    const track = toggle?.firstElementChild as HTMLElement | null;
    const thumb = track?.firstElementChild as HTMLElement | null;
    // Core's switch geometry (40×22 track, 18 thumb) and the host's own switch roles.
    expect(getComputedStyle(track!).width).toBe('40px');
    expect(getComputedStyle(track!).height).toBe('22px');
    expect(getComputedStyle(track!).backgroundColor).toBe('rgb(18, 52, 86)');
    expect(getComputedStyle(thumb!).backgroundColor).toBe('rgb(254, 220, 186)');

    await act(async () => {
      toggle?.focus();
      toggle?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(getComputedStyle(track!).backgroundColor).toBe('rgb(101, 67, 33)');
    mount.unmount();
  });

  it('presents a field Select as a field box naming the chosen option that opens the shared menu', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<string | undefined>(undefined);
      return (
        <Form.Select
          label="Order"
          presentation="field"
          value={value}
          options={fieldOrderOptions}
          onChange={(next) => { onChange(next); setValue(next as string); }}
        />
      );
    }
    const mount = mountWithPalette(<Harness />);

    // The row title names the field, so the box shows only the choice — or asks for one.
    let trigger = mount.container.querySelector<HTMLElement>('[aria-haspopup="menu"]');
    expect(trigger?.getAttribute('aria-label')).toBe('Order');
    expect(trigger?.textContent).toBe('Choose…');
    expect(mount.container.textContent).not.toContain('Order');
    const box = trigger?.firstElementChild as HTMLElement | null;
    expect(getComputedStyle(box!).borderTopColor).toBe('rgb(171, 205, 239)');

    await act(async () => { trigger?.click(); });
    const items = [...mount.container.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false']);
    await act(async () => { items[1]?.click(); });

    expect(onChange).toHaveBeenLastCalledWith('oldest');
    trigger = mount.container.querySelector<HTMLElement>('[aria-haspopup="menu"]');
    expect(trigger?.textContent).toBe('Oldest');
    expect(trigger?.getAttribute('aria-label')).toBe('Order: Oldest');
    mount.unmount();
  });

  it('presents a segmented Select as a labelled radiogroup with arrow-key selection', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<string>('newest');
      return (
        <Form.Select
          label="Order"
          presentation="segmented"
          value={value}
          options={[
            { value: 'newest', label: 'Newest' },
            { value: 'oldest', label: 'Oldest', disabled: true },
            { value: 'smart', label: 'Smart' },
          ]}
          onChange={(next) => { onChange(next); setValue(next as string); }}
        />
      );
    }
    const mount = mountWithPalette(<Harness />);

    const group = mount.container.querySelector<HTMLElement>('[role="radiogroup"]');
    expect(group?.getAttribute('aria-label')).toBe('Order');
    let radios = [...mount.container.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.map((radio) => radio.textContent)).toEqual(['Newest', 'Oldest', 'Smart']);
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(radios.map((radio) => radio.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(getComputedStyle(group!).backgroundColor).toBe('rgb(225, 225, 225)');

    // The unavailable segment is skipped, and focus follows the selection.
    await act(async () => {
      radios[0]?.focus();
      radios[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    radios = [...mount.container.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(onChange).toHaveBeenLastCalledWith('smart');
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
    expect(document.activeElement).toBe(radios[2]);

    await act(async () => { radios[0]?.click(); });
    expect(onChange).toHaveBeenLastCalledWith('newest');
    mount.unmount();
  });

  it('rejects a multiple-choice segmented Select', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => mountForm(
      <Form.Select
        label="Sources"
        presentation="segmented"
        multiple
        value={['a']}
        options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]}
        onChange={() => undefined}
      />,
    )).toThrow(/segmented/u);
    error.mockRestore();
  });

  function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('presents a field TextField as the page field box, named by the row it sits in', () => {
    const mount = mountWithPalette(
      <Form.TextField label="Display name" presentation="field" value="" placeholder="Review bot" onChange={() => undefined} testID="name-field" />,
    );
    const input = mount.container.querySelector<HTMLInputElement>('[data-testid="name-field"]')!;
    expect(input.getAttribute('aria-label')).toBe('Display name');
    // The row title names the field: the field draws no visible label of its own.
    expect(mount.container.textContent).not.toContain('Display name');
    const box = input.parentElement!;
    expect(getComputedStyle(box).borderTopColor).toBe('rgb(171, 205, 239)');
    expect(getComputedStyle(box).backgroundColor).toBe('rgb(253, 253, 253)');
    expect(box.style.borderTopLeftRadius).toBe(`${HAPPIER_FIELD_BOX_METRICS.radiusPx}px`);
    mount.unmount();
  });

  it('keeps a field TextField draft local and commits it once when focus leaves', async () => {
    const onCommit = vi.fn();
    const onChange = vi.fn();
    const mount = mountWithPalette(
      <Form.TextField
        label="Retries"
        presentation="field"
        kind="integer"
        value="3"
        onChange={onChange}
        onCommit={onCommit}
        testID="retries-field"
      />,
    );
    const input = mount.container.querySelector<HTMLInputElement>('[data-testid="retries-field"]')!;

    await act(async () => { setInputValue(input, '1a2'); });
    // The draft keeps only digits and stays in the field while typing.
    expect(input.value).toBe('12');
    expect(onChange).toHaveBeenLastCalledWith('12');
    expect(onCommit).not.toHaveBeenCalled();

    await act(async () => { input.dispatchEvent(new FocusEvent('blur')); input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('12');

    // An emptied number returns to the saved value instead of committing nothing.
    await act(async () => { setInputValue(input, ''); });
    await act(async () => { input.dispatchEvent(new FocusEvent('blur')); input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('3');
    mount.unmount();
  });

  it('shows a field TextField refusal beneath the box and announces it', () => {
    const mount = mountWithPalette(
      <Form.TextField label="Endpoint" presentation="field" value="ftp://x" onChange={() => undefined} error="Use an https:// address." testID="endpoint-field" />,
    );
    const input = mount.container.querySelector<HTMLInputElement>('[data-testid="endpoint-field"]')!;
    const alert = mount.container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toBe('Use an https:// address.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    mount.unmount();
  });
});
