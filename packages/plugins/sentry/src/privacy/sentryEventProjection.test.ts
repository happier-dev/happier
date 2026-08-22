import { describe, expect, it } from 'vitest';

import {
  SENTRY_EVENT_BOUNDS_V1,
  projectSentryEventForDisplay,
} from './sentryEventProjection.js';

const ACTION_BYTE_GATE = 1_024 * 1_024;

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function frame(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    filename: 'app/checkout.ts',
    function: 'submitOrder',
    lineNo: 42,
    colNo: 7,
    inApp: true,
    context: [[41, 'const total = cart.total;'], [42, 'await charge(card, total);']],
    vars: { card: '4111111111111111', total: 9_900 },
    ...overrides,
  };
}

function exceptionEvent(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    eventID: 'a'.repeat(32),
    dateCreated: '2026-02-03T04:05:06.000Z',
    title: 'ChargeDeclined: card was declined',
    message: 'card was declined',
    location: 'app/checkout.ts',
    culprit: 'submitOrder(app/checkout)',
    platform: 'javascript',
    entries: [{
      type: 'exception',
      data: {
        values: [{
          type: 'ChargeDeclined',
          value: 'card was declined',
          stacktrace: { frames: [frame()] },
        }],
      },
    }],
    ...overrides,
  };
}

describe('Sentry event projection — what may leave this source', () => {
  it('copies the named identity fields and nothing the body also carried', () => {
    const projected = projectSentryEventForDisplay(exceptionEvent({
      // Neither is named by the projection type, so neither may appear in it.
      contexts: { device: { name: 'Ada’s laptop' } },
      userReport: { email: 'ada@example.com', comments: 'it broke' },
    }));

    expect(projected.eventId).toBe('a'.repeat(32));
    expect(projected.dateCreatedMs).toBe(Date.parse('2026-02-03T04:05:06.000Z'));
    expect(projected.title).toBe('ChargeDeclined: card was declined');
    expect(projected.culprit).toBe('submitOrder(app/checkout)');
    expect(JSON.stringify(projected)).not.toContain('Ada’s laptop');
    expect(JSON.stringify(projected)).not.toContain('ada@example.com');
    expect(projected.redactions).toContainEqual({ path: 'contexts', reason: 'pluginWithheld' });
    expect(projected.redactions).toContainEqual({ path: 'userReport', reason: 'pluginWithheld' });
  });

  it('drops a top-level `formatted` rendering rather than letting it reach a renderer', () => {
    // §8.5: `llmFormat` is never sent, but an intermediary or a provider default
    // could still attach a prose rendering of the very values §8.3 withholds.
    const projected = projectSentryEventForDisplay(exceptionEvent({
      formatted: '# Event\nvars: card=4111111111111111',
    }));

    expect(JSON.stringify(projected)).not.toContain('4111111111111111');
    expect(projected.redactions).toContainEqual({ path: 'formatted', reason: 'pluginWithheld' });
  });

  it('renders the exception chain in provider order with its frames', () => {
    const projected = projectSentryEventForDisplay(exceptionEvent());

    expect(projected.sections).toEqual([{
      kind: 'exception',
      type: 'ChargeDeclined',
      value: 'card was declined',
      frames: [{
        filename: 'app/checkout.ts',
        function: 'submitOrder',
        lineNo: 42,
        colNo: 7,
        inApp: true,
        contextLine: 'await charge(card, total);',
        vars: {},
      }],
    }]);
  });

  it('withholds every frame local and says so per frame', () => {
    const projected = projectSentryEventForDisplay(exceptionEvent());

    const [section] = projected.sections;
    expect(section?.kind).toBe('exception');
    if (section?.kind !== 'exception') return;
    expect(section.frames[0]?.vars).toEqual({});
    expect(JSON.stringify(projected)).not.toContain('4111111111111111');
    expect(projected.redactions).toContainEqual({
      path: 'entries[0].data.frames[0].vars',
      reason: 'pluginWithheld',
    });
  });

  it('honours a `_meta` annotation on an allow-listed path and never renders the raw value', () => {
    const projected = projectSentryEventForDisplay({
      ...exceptionEvent(),
      user: { id: '7', email: 'ada@example.com' },
      _meta: {
        user: { email: { '': { rem: [['@email', 's', 0, 12]] } } },
      },
    });

    expect(projected.user).toEqual({
      id: '7',
      email: null,
      username: null,
      ipAddress: null,
      name: null,
    });
    expect(JSON.stringify(projected)).not.toContain('ada@example.com');
    expect(projected.redactions).toContainEqual({
      path: 'user.email',
      reason: 'providerScrubbed',
    });
  });

  it('treats an unreadable `_meta` node as a scrub rather than as proof the value is clean', () => {
    const projected = projectSentryEventForDisplay({
      ...exceptionEvent(),
      user: { email: 'ada@example.com' },
      // A shape this bounded parser does not recognize. Interpreting it as "no
      // annotation" would render a value the customer's own rules may have
      // scrubbed.
      _meta: { user: { email: { '': { chunks: 'not-an-array' } } } },
    });

    expect(projected.user?.email).toBeNull();
    expect(projected.redactions).toContainEqual({
      path: 'user.email',
      reason: 'providerScrubbed',
    });
  });

  it('withholds a value whose annotation uses a key this build does not recognize', () => {
    const projected = projectSentryEventForDisplay({
      ...exceptionEvent(),
      user: { name: 'Ada Lovelace' },
      // A leaf carrying none of `rem`, `err` or `chunks`. Sentry may add another
      // annotation vocabulary, and "this build does not know what that means" is
      // not the same fact as "this value was never annotated".
      _meta: { user: { name: { '': { scrubbed_by: '@name' } } } },
    });

    expect(projected.user?.name).toBeNull();
    expect(JSON.stringify(projected)).not.toContain('Ada Lovelace');
    expect(projected.redactions).toContainEqual({
      path: 'user.name',
      reason: 'providerScrubbed',
    });
  });

  it('reads a chunked redaction annotation as a scrub', () => {
    const projected = projectSentryEventForDisplay({
      ...exceptionEvent(),
      user: { username: 'ada' },
      _meta: {
        user: { username: { '': { chunks: [{ type: 'redaction', rule_id: '@password' }] } } },
      },
    });

    expect(projected.user?.username).toBeNull();
    // The provider's rule id is never republished, only the fact of the scrub.
    expect(JSON.stringify(projected)).not.toContain('@password');
    expect(projected.redactions).toContainEqual({
      path: 'user.username',
      reason: 'providerScrubbed',
    });
  });

  it('honours a `_meta` annotation on an exception value and on a stack frame', () => {
    // The provider's own scrubbing rules reach far past tags and user: the
    // exception message and the frame that carries the reader's file paths are
    // where `@creditcard` and `@userpath` actually fire.
    const projected = projectSentryEventForDisplay({
      ...exceptionEvent({
        entries: [{
          type: 'exception',
          data: {
            values: [{
              type: 'ChargeDeclined',
              value: 'card 4111111111111111 was declined',
              stacktrace: {
                frames: [frame({
                  filename: '/Users/ada/secret-project/checkout.ts',
                  vars: undefined,
                })],
              },
            }],
          },
        }],
      }),
      _meta: {
        entries: {
          '0': {
            data: {
              values: {
                '0': {
                  value: { '': { rem: [['@creditcard', 's', 5, 25]] } },
                  stacktrace: {
                    frames: {
                      '0': {
                        filename: {
                          '': { chunks: [{ type: 'redaction', rule_id: '@userpath' }] },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('4111111111111111');
    expect(serialized).not.toContain('secret-project');
    // The provider's rule ids are never republished, only the fact of the scrub.
    expect(serialized).not.toContain('@creditcard');
    expect(serialized).not.toContain('@userpath');

    const [section] = projected.sections;
    expect(section?.kind).toBe('exception');
    if (section?.kind !== 'exception') return;
    expect(section.value).toBe('');
    expect(section.frames[0]?.filename).toBeNull();
    // The structure around the two scrubbed values still renders.
    expect(section.type).toBe('ChargeDeclined');
    expect(section.frames[0]?.function).toBe('submitOrder');
    expect(section.frames[0]?.lineNo).toBe(42);

    expect(projected.redactions).toContainEqual({
      path: 'entries[0].data.values[0].value',
      reason: 'providerScrubbed',
    });
    expect(projected.redactions).toContainEqual({
      path: 'entries[0].data.frames[0].filename',
      reason: 'providerScrubbed',
    });
  });

  it('honours a `_meta` annotation on a breadcrumb, a message section and a top-level field', () => {
    const projected = projectSentryEventForDisplay({
      ...exceptionEvent({
        location: '/Users/ada/secret-project/checkout.ts',
        entries: [
          {
            type: 'breadcrumbs',
            data: {
              values: [{
                timestamp: '2026-02-03T04:05:00.000Z',
                category: 'fetch',
                level: 'info',
                message: 'POST /charge pan=4111111111111111',
              }],
            },
          },
          { type: 'message', data: { formatted: 'declined for ada@example.com' } },
        ],
      }),
      _meta: {
        location: { '': { rem: [['@userpath', 's', 0, 10]] } },
        entries: {
          '0': {
            data: {
              values: { '0': { message: { '': { rem: [['@creditcard', 's', 0, 10]] } } } },
            },
          },
          '1': { data: { formatted: { '': { rem: [['@email', 's', 0, 10]] } } } },
        },
      },
    });

    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('4111111111111111');
    expect(serialized).not.toContain('ada@example.com');
    expect(serialized).not.toContain('secret-project');

    expect(projected.location).toBeNull();
    const [breadcrumbs] = projected.sections;
    expect(breadcrumbs?.kind).toBe('breadcrumbs');
    if (breadcrumbs?.kind !== 'breadcrumbs') return;
    expect(breadcrumbs.entries[0]?.message).toBeNull();
    // The surrounding breadcrumb is still shown.
    expect(breadcrumbs.entries[0]?.category).toBe('fetch');
    // A message section whose only text was scrubbed carries no section at all.
    expect(projected.sections).toHaveLength(1);

    expect(projected.redactions).toContainEqual({
      path: 'location',
      reason: 'providerScrubbed',
    });
    expect(projected.redactions).toContainEqual({
      path: 'entries[0].data.values[0].message',
      reason: 'providerScrubbed',
    });
    expect(projected.redactions).toContainEqual({
      path: 'entries[1].data.formatted',
      reason: 'providerScrubbed',
    });
  });

  it('names the retained event body content it still carries in `sensitivePaths`', () => {
    // §8.4 builds its disclosure from this array. A projection carrying a whole
    // stack trace, its source context lines and an exception message must not
    // report the same empty set as one carrying nothing.
    const projected = projectSentryEventForDisplay(exceptionEvent({
      entries: [
        {
          type: 'exception',
          data: {
            values: [{
              type: 'ChargeDeclined',
              value: 'card was declined',
              stacktrace: { frames: [frame({ vars: undefined })] },
            }],
          },
        },
        {
          type: 'breadcrumbs',
          data: { values: [{ category: 'fetch', level: 'info', message: 'POST /charge' }] },
        },
      ],
    }));

    expect(projected.sensitivePaths).toContain('entries[0].data.values[0].value');
    expect(projected.sensitivePaths).toContain('entries[0].data.frames[].filename');
    expect(projected.sensitivePaths).toContain('entries[0].data.frames[].contextLine');
    expect(projected.sensitivePaths).toContain('entries[1].data.values[].message');
    // A repeated field is named once, not once per element: the ceiling exists to
    // carry every kind of retained content, not forty copies of one kind.
    expect(projected.sensitivePaths.filter((path) => path.includes('[]'))
      .every((path) => !/\[\d+\]\.(filename|contextLine|message)$/u.test(path))).toBe(true);
    // Tier-A row facts are not sensitive-path material; they are already the list row.
    expect(projected.sensitivePaths).not.toContain('title');
    expect(projected.sensitivePaths).not.toContain('culprit');
  });

  it('publishes only allow-listed tag keys and names the ones it withheld', () => {
    const projected = projectSentryEventForDisplay({
      ...exceptionEvent(),
      tags: [
        { key: 'release', value: '1.4.2' },
        { key: 'url', value: 'https://shop.example.com/checkout?token=secret' },
        { key: 'internal_auth_token', value: 'ghp_notatoken' },
      ],
    });

    expect(projected.tags).toEqual([
      { key: 'release', value: '1.4.2' },
      { key: 'url', value: 'https://shop.example.com/checkout?token=secret' },
    ]);
    expect(JSON.stringify(projected)).not.toContain('ghp_notatoken');
    expect(projected.redactions).toContainEqual({
      path: 'tags[2]',
      reason: 'pluginWithheld',
    });
    // A build metadata tag is not sensitive; an environment/identity one is, and
    // the disclosure names it rather than guessing from a boolean.
    expect(projected.sensitivePaths).toContain('tags.url');
    expect(projected.sensitivePaths).not.toContain('tags.release');
  });

  it('maps only the five allow-listed user fields and withholds the rest', () => {
    const projected = projectSentryEventForDisplay({
      ...exceptionEvent(),
      user: {
        id: '7',
        email: 'ada@example.com',
        username: 'ada',
        ip_address: '203.0.113.9',
        name: 'Ada Lovelace',
        geo: { city: 'London', region: 'GB' },
        data: { plan: 'enterprise', internalNote: 'VIP' },
      },
    });

    expect(projected.user).toEqual({
      id: '7',
      email: 'ada@example.com',
      username: 'ada',
      ipAddress: '203.0.113.9',
      name: 'Ada Lovelace',
    });
    expect(JSON.stringify(projected)).not.toContain('London');
    expect(JSON.stringify(projected)).not.toContain('enterprise');
    expect(projected.redactions).toContainEqual({ path: 'user.geo', reason: 'pluginWithheld' });
    expect(projected.redactions).toContainEqual({ path: 'user.data', reason: 'pluginWithheld' });
    expect(projected.sensitivePaths).toContain('user.email');
    expect(projected.sensitivePaths).toContain('user.ipAddress');
  });

  it('keeps a breadcrumb’s four stated fields and withholds its payload bag', () => {
    const projected = projectSentryEventForDisplay(exceptionEvent({
      entries: [{
        type: 'breadcrumbs',
        data: {
          values: [{
            timestamp: '2026-02-03T04:05:00.000Z',
            category: 'fetch',
            level: 'info',
            message: 'POST /charge',
            data: { authorization: 'Bearer notatoken', body: '{"pan":"4111111111111111"}' },
          }],
        },
      }],
    }));

    expect(projected.sections).toEqual([{
      kind: 'breadcrumbs',
      entries: [{
        timestampMs: Date.parse('2026-02-03T04:05:00.000Z'),
        category: 'fetch',
        level: 'info',
        message: 'POST /charge',
      }],
    }]);
    expect(JSON.stringify(projected)).not.toContain('Bearer notatoken');
    expect(projected.redactions).toContainEqual({
      path: 'entries[0].data.values[0].data',
      reason: 'pluginWithheld',
    });
  });

  it('names an entry type it does not understand instead of dropping or rendering it', () => {
    const projected = projectSentryEventForDisplay(exceptionEvent({
      entries: [
        { type: 'request', data: { headers: [['cookie', 'session=notatoken']] } },
        { type: 'message', data: { formatted: 'card was declined' } },
      ],
    }));

    expect(projected.sections).toEqual([
      { kind: 'unsupported', entryType: 'request' },
      { kind: 'message', formatted: 'card was declined' },
    ]);
    expect(JSON.stringify(projected)).not.toContain('session=notatoken');
  });

  it('falls back to a message interface’s own `message` when its `formatted` is blank', () => {
    const projected = projectSentryEventForDisplay(exceptionEvent({
      entries: [{ type: 'message', data: { formatted: '', message: 'card was declined' } }],
    }));

    expect(projected.sections).toEqual([{ kind: 'message', formatted: 'card was declined' }]);
    expect(projected.sensitivePaths).toContain('entries[0].data.message');
  });

  it('skips a malformed sibling and keeps every valid one', () => {
    const projected = projectSentryEventForDisplay(exceptionEvent({
      entries: [
        'not an entry',
        { type: 'stacktrace', data: { frames: [frame({ vars: undefined })] } },
      ],
    }));

    expect(projected.sections).toHaveLength(1);
    expect(projected.sections[0]?.kind).toBe('stacktrace');
  });

  it('keeps the frames nearest the crash when a stack exceeds the ceiling', () => {
    const total = SENTRY_EVENT_BOUNDS_V1.maxFramesPerSection + 3;
    const frames = Array.from({ length: total }, (_, index) => frame({
      function: `frame${String(index)}`,
      vars: undefined,
    }));
    const projected = projectSentryEventForDisplay(exceptionEvent({
      entries: [{ type: 'stacktrace', data: { frames } }],
    }));

    const [section] = projected.sections;
    expect(section?.kind).toBe('stacktrace');
    if (section?.kind !== 'stacktrace') return;
    expect(section.frames).toHaveLength(SENTRY_EVENT_BOUNDS_V1.maxFramesPerSection);
    // Sentry returns a stack oldest-first, so the crash site is the last frame.
    // Dropping the tail would remove the only frame most readers open this for.
    expect(section.frames.at(-1)?.function).toBe(`frame${String(total - 1)}`);
    expect(section.frames[0]?.function).toBe('frame3');
    expect(projected.omitted.frames).toBe(3);
    expect(projected.projectionTruncated).toBe(true);
  });

  it('shortens an oversized value rather than rejecting the whole event', () => {
    const projected = projectSentryEventForDisplay(exceptionEvent({
      entries: [{
        type: 'exception',
        data: {
          values: [{
            type: 'ChargeDeclined',
            // A provider-valid message far past the display bound, carrying a
            // newline the strict single-line contract would otherwise reject.
            value: `first line\n${'x'.repeat(4_000)}`,
            stacktrace: { frames: [] },
          }],
        },
      }],
    }));

    const [section] = projected.sections;
    expect(section?.kind).toBe('exception');
    if (section?.kind !== 'exception') return;
    expect(section.value).not.toContain('\n');
    expect(new TextEncoder().encode(section.value).length)
      .toBeLessThanOrEqual(SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes);
    expect(projected.projectionTruncated).toBe(true);
  });

  it('reports an event body it cannot read at all as an empty projection, not a throw', () => {
    const projected = projectSentryEventForDisplay('not an event');

    expect(projected.eventId).toBe('');
    expect(projected.sections).toEqual([]);
    expect(projected.user).toBeNull();
  });

  it('clears the byte gate with every collection saturated at once', () => {
    // The gate is the one hard constraint that exists: the Action aggregate
    // rejects a result over a mebibyte outright, and a rejected result shows the
    // reader nothing at all. Every ceiling above is derived from this measurement
    // rather than from a guess about how deep a real stack is.
    const long = (bytes: number, seed: string): string => seed.repeat(bytes);
    const frames = Array.from(
      { length: SENTRY_EVENT_BOUNDS_V1.maxFramesPerSection },
      () => ({
        filename: long(SENTRY_EVENT_BOUNDS_V1.locationUtf8Bytes, 'f'),
        function: long(SENTRY_EVENT_BOUNDS_V1.labelUtf8Bytes, 'g'),
        lineNo: 999_999,
        colNo: 999_999,
        inApp: true,
        context: [[999_999, long(SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, 'c')]],
        vars: { a: 1 },
      }),
    );
    const saturated = {
      eventID: 'a'.repeat(32),
      dateCreated: '2026-02-03T04:05:06.000Z',
      title: long(SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, 't'),
      message: long(SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, 'm'),
      location: long(SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, 'l'),
      culprit: long(SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, 'p'),
      platform: long(SENTRY_EVENT_BOUNDS_V1.labelUtf8Bytes, 'y'),
      user: {
        id: long(SENTRY_EVENT_BOUNDS_V1.identifierUtf8Bytes, 'i'),
        email: long(SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, 'e'),
        username: long(SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, 'u'),
        ip_address: long(SENTRY_EVENT_BOUNDS_V1.identifierUtf8Bytes, '1'),
        name: long(SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, 'n'),
      },
      tags: Array.from({ length: SENTRY_EVENT_BOUNDS_V1.maxTags }, () => ({
        key: 'url',
        value: long(SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, 'v'),
      })),
      entries: [
        ...Array.from({ length: SENTRY_EVENT_BOUNDS_V1.maxSections - 1 }, () => ({
          type: 'exception',
          data: {
            values: [{
              type: long(SENTRY_EVENT_BOUNDS_V1.labelUtf8Bytes, 'T'),
              value: long(SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, 'V'),
              stacktrace: { frames },
            }],
          },
        })),
        {
          type: 'breadcrumbs',
          data: {
            values: Array.from({ length: SENTRY_EVENT_BOUNDS_V1.maxBreadcrumbs }, () => ({
              timestamp: '2026-02-03T04:05:00.000Z',
              category: long(SENTRY_EVENT_BOUNDS_V1.labelUtf8Bytes, 'k'),
              level: long(SENTRY_EVENT_BOUNDS_V1.labelUtf8Bytes, 'w'),
              message: long(SENTRY_EVENT_BOUNDS_V1.textUtf8Bytes, 'b'),
              data: { a: 1 },
            })),
          },
        },
      ],
    };

    expect(encodedBytes(projectSentryEventForDisplay(saturated)))
      .toBeLessThan(ACTION_BYTE_GATE);
  });
});
