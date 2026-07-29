import { describe, expect, it } from 'vitest';

import {
  parseLocator,
  resolveLocator,
  synthesizeLocatorElementExpression,
  synthesizeLocatorExpression,
  type LocatorElement,
} from './locators';

// Fixture DOM: a button, a link, a test-id input, and a css-classed div.
const fixture: LocatorElement = {
  tag: 'body',
  children: [
    { tag: 'button', attributes: { id: 'submit-btn' }, text: 'Submit' },
    { tag: 'a', attributes: { href: '/next', class: 'cta primary' }, text: 'Go next' },
    { tag: 'input', attributes: { 'data-testid': 'email-field', type: 'email' } },
    { tag: 'div', attributes: { role: 'alert', class: 'banner' }, text: 'Heads up' },
  ],
};

type AggregateTextInput = Readonly<{
  tag: string;
  attributes?: Readonly<Record<string, string>>;
  ownText?: string;
  children?: readonly AggregateTextInput[];
}>;

function withAggregateText(input: AggregateTextInput): LocatorElement {
  const children = (input.children ?? []).map(withAggregateText);
  const text = [input.ownText ?? '', ...children.map((child) => child.text ?? '')]
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return {
    tag: input.tag,
    ...(input.attributes ? { attributes: input.attributes } : {}),
    ...(text ? { text } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}

type FakeElement = Readonly<{
  tagName: string;
  textContent: string;
  children: readonly FakeElement[];
  getAttribute(name: string): string | null;
}>;

function fakeElement(input: Readonly<{
  tagName: string;
  textContent: string;
  attributes?: Readonly<Record<string, string>>;
  children?: readonly FakeElement[];
}>): FakeElement {
  return {
    tagName: input.tagName.toUpperCase(),
    textContent: input.textContent,
    children: input.children ?? [],
    getAttribute(name) {
      return input.attributes?.[name] ?? null;
    },
  };
}

function executeElementExpression(expression: string, documentValue: Readonly<{ querySelectorAll(selector: string): readonly FakeElement[] }>): unknown {
  return Function('document', `return ${expression};`)(documentValue);
}

describe('semantic locators (BA-3)', () => {
  it('parses each locator strategy', () => {
    expect(parseLocator('role=button[name="Submit"]')).toEqual({ strategy: 'role', role: 'button', name: 'Submit' });
    expect(parseLocator('text=Go next')).toEqual({ strategy: 'text', text: 'Go next' });
    expect(parseLocator('data-testid=email-field')).toEqual({ strategy: 'testid', testId: 'email-field' });
    expect(parseLocator('testid=email-field')).toEqual({ strategy: 'testid', testId: 'email-field' });
    expect(parseLocator('.cta')).toEqual({ strategy: 'css', selector: '.cta' });
  });

  it('resolves role= against the fixture DOM (implicit + explicit roles, with name)', () => {
    const button = resolveLocator(parseLocator('role=button[name="Submit"]'), fixture);
    expect(button?.attributes?.id).toBe('submit-btn');

    const alert = resolveLocator(parseLocator('role=alert'), fixture);
    expect(alert?.attributes?.class).toBe('banner');
  });

  it('resolves text= against the fixture DOM', () => {
    const link = resolveLocator(parseLocator('text=Go next'), fixture);
    expect(link?.tag).toBe('a');
  });

  it('resolves text= to the most specific descendant text owner, not aggregate ancestors', () => {
    const button = {
      tag: 'button',
      attributes: { id: 'continue' },
      ownText: 'Continue',
    } satisfies AggregateTextInput;
    const root = withAggregateText({
      tag: 'body',
      ownText: 'Welcome',
      children: [
        {
          tag: 'main',
          ownText: 'Choose an action',
          children: [button],
        },
      ],
    });

    const result = resolveLocator(parseLocator('text=Continue'), root);

    expect(result?.tag).toBe('button');
    expect(result?.attributes?.id).toBe('continue');
  });

  it('resolves data-testid= against the fixture DOM', () => {
    const input = resolveLocator(parseLocator('data-testid=email-field'), fixture);
    expect(input?.attributes?.type).toBe('email');
  });

  it('resolves CSS (#id, .class, tag[attr=value]) against the fixture DOM', () => {
    expect(resolveLocator(parseLocator('#submit-btn'), fixture)?.tag).toBe('button');
    expect(resolveLocator(parseLocator('.primary'), fixture)?.tag).toBe('a');
    expect(resolveLocator(parseLocator('input[type="email"]'), fixture)?.attributes?.['data-testid']).toBe('email-field');
  });

  it('returns null when nothing matches', () => {
    expect(resolveLocator(parseLocator('role=button[name="Nope"]'), fixture)).toBeNull();
    expect(resolveLocator(parseLocator('text=missing'), fixture)).toBeNull();
    expect(resolveLocator(parseLocator('.does-not-exist'), fixture)).toBeNull();
  });

  it('synthesizes a self-contained in-page resolution expression per strategy', () => {
    for (const input of ['role=button[name="Submit"]', 'text=Go next', 'data-testid=email-field', '.cta']) {
      const expression = synthesizeLocatorExpression(parseLocator(input));
      expect(expression).toContain('getBoundingClientRect');
      // The expression is a self-contained IIFE returning a center point or null.
      expect(expression.trimStart().startsWith('(() =>')).toBe(true);
    }
  });

  it('synthesizes text= expression that returns the descendant owner instead of html/body aggregate text', () => {
    const button = fakeElement({ tagName: 'button', textContent: 'Continue', attributes: { id: 'continue' } });
    const main = fakeElement({ tagName: 'main', textContent: 'Choose an action Continue', children: [button] });
    const body = fakeElement({ tagName: 'body', textContent: 'Welcome Choose an action Continue', children: [main] });
    const html = fakeElement({ tagName: 'html', textContent: 'Welcome Choose an action Continue', children: [body] });
    const documentValue = {
      querySelectorAll(selector: string) {
        return selector === '*' ? [html, body, main, button] : [];
      },
    };

    const expression = synthesizeLocatorElementExpression(parseLocator('text=Continue'));

    expect(executeElementExpression(expression, documentValue)).toBe(button);
  });
});
