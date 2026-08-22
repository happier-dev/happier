import { describe, expect, it } from 'vitest';

import { parseForgeLinkHeader, readForgeLinkHeaderValue } from './linkHeader.js';

describe('parseForgeLinkHeader', () => {
  it('parses every rel in a multi-link header', () => {
    expect(parseForgeLinkHeader(
      '<https://f.test/a?page=1>; rel="first", <https://f.test/a?page=3>; rel="next"',
    )).toEqual({
      first: 'https://f.test/a?page=1',
      next: 'https://f.test/a?page=3',
    });
  });

  it('does not split a link-value on a comma inside its own URL', () => {
    // A forge query may carry a literal comma, and RFC 8288 separates link-values only
    // between them. Splitting on every comma silently loses the next page.
    const header = '<https://f.test/search?q=label%3Aa+milestone%3A1,2&page=2>; rel="next"';
    expect(parseForgeLinkHeader(header)).toEqual({
      next: 'https://f.test/search?q=label%3Aa+milestone%3A1,2&page=2',
    });
  });

  it('accepts a bare rel, extra parameters and irregular spacing', () => {
    expect(parseForgeLinkHeader('  <https://f.test/a>;rel=next ; type="x"  ')).toEqual({
      next: 'https://f.test/a',
    });
    expect(parseForgeLinkHeader('<https://f.test/a>; type="x"; rel="next"')).toEqual({
      next: 'https://f.test/a',
    });
  });

  it('lower-cases the rel so a differently cased header still names the next page', () => {
    expect(parseForgeLinkHeader('<https://f.test/a>; rel="NEXT"')).toEqual({
      next: 'https://f.test/a',
    });
  });

  it('keeps the first occurrence of a duplicated rel', () => {
    expect(parseForgeLinkHeader('<https://f.test/1>; rel="next", <https://f.test/2>; rel="next"'))
      .toEqual({ next: 'https://f.test/1' });
  });

  it('yields nothing for an absent or unparseable header', () => {
    expect(parseForgeLinkHeader(null)).toEqual({});
    expect(parseForgeLinkHeader(undefined)).toEqual({});
    expect(parseForgeLinkHeader('')).toEqual({});
    expect(parseForgeLinkHeader('garbage')).toEqual({});
    expect(parseForgeLinkHeader('<https://f.test/a>')).toEqual({});
    expect(parseForgeLinkHeader('<https://f.test/a>; rel=""')).toEqual({});
  });
});

describe('readForgeLinkHeaderValue', () => {
  it('reads the header under any casing and trims it', () => {
    expect(readForgeLinkHeaderValue({ Link: '  <https://f.test/a>; rel="next" ' }))
      .toBe('<https://f.test/a>; rel="next"');
    expect(readForgeLinkHeaderValue({ link: '<https://f.test/a>; rel="next"' }))
      .toBe('<https://f.test/a>; rel="next"');
  });

  it('returns null when the header is absent or empty', () => {
    expect(readForgeLinkHeaderValue({})).toBeNull();
    expect(readForgeLinkHeaderValue({ link: '   ' })).toBeNull();
  });
});
