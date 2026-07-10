import { describe, expect, it } from 'vitest';

import {
  redactBrowserAutomationActionResultDetails,
  redactBrowserAutomationTimelineDetails,
} from './redaction.js';

// L2-3 (RU2 capstone): agent-facing automation timeline/result redaction must classify URL
// values by VALUE SHAPE, not key name. A token-bearing URL under ANY key (href/src/location/
// currentUrl/an arbitrary key) must never reach an agent timeline raw — neither its query
// values nor token-shaped path segments (e.g. /reset/<token>).
const QUERY_TOKEN = 'sk_live_totally_secret_query_token';
const PATH_TOKEN = 'tok9f8e7d6c5b4a3210ffeeddcc';
const SEEDED_URL = `https://app.example.test/reset/${PATH_TOKEN}?token=${QUERY_TOKEN}&page=2`;

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

describe('redactBrowserAutomationTimelineDetails — URL value-shape redaction', () => {
  it('strips query and token path segments when the key is literally "url" (regression)', () => {
    const out = serialized(redactBrowserAutomationTimelineDetails({ url: SEEDED_URL }));
    expect(out).not.toContain(QUERY_TOKEN);
    expect(out).not.toContain(PATH_TOKEN);
    expect(out).toContain('https://app.example.test');
  });

  it.each(['href', 'src', 'location', 'currentUrl', 'destination', 'somethingElse'])(
    'strips a token-bearing URL under the non-"url" key %s',
    (key) => {
      const out = serialized(redactBrowserAutomationTimelineDetails({ [key]: SEEDED_URL }));
      expect(out).not.toContain(QUERY_TOKEN);
      expect(out).not.toContain(PATH_TOKEN);
    },
  );

  it('returns an agent-facing redacted copy without mutating local-owner values', () => {
    const localOwnerDetails = {
      arbitraryTimelineField: SEEDED_URL,
      nested: { redirectedTo: SEEDED_URL },
    };

    const agentFacing = redactBrowserAutomationTimelineDetails(localOwnerDetails);

    expect(serialized(agentFacing)).not.toContain(QUERY_TOKEN);
    expect(serialized(agentFacing)).not.toContain(PATH_TOKEN);
    expect(localOwnerDetails.arbitraryTimelineField).toBe(SEEDED_URL);
    expect(localOwnerDetails.nested.redirectedTo).toBe(SEEDED_URL);
  });

  it('strips URLs embedded inside prose string values', () => {
    const out = serialized(redactBrowserAutomationTimelineDetails({
      note: `open ${SEEDED_URL} before it expires`,
    }));
    expect(out).not.toContain(QUERY_TOKEN);
    expect(out).not.toContain(PATH_TOKEN);
    expect(out).toContain('open ');
  });

  it('strips URL-encoded token URLs under arbitrary keys and inside prose', () => {
    const encodedUrl = encodeURIComponent(SEEDED_URL);
    const out = serialized(redactBrowserAutomationTimelineDetails({
      definitelyNotAUrlKey: encodedUrl,
      note: `open ${encodedUrl} before it expires`,
    }));
    expect(out).not.toContain(QUERY_TOKEN);
    expect(out).not.toContain(PATH_TOKEN);
    expect(out).not.toContain(encodeURIComponent(QUERY_TOKEN));
    expect(out).not.toContain(encodeURIComponent(PATH_TOKEN));
    expect(out).toContain('https://app.example.test/reset/:redacted');
  });

  it('strips token URLs nested in arrays and records', () => {
    const out = serialized(redactBrowserAutomationTimelineDetails({
      steps: [{ detail: { redirectedTo: SEEDED_URL } }, [SEEDED_URL]],
    }));
    expect(out).not.toContain(QUERY_TOKEN);
    expect(out).not.toContain(PATH_TOKEN);
  });

  it('reduces non-http(s)/ws(s) URL values to their scheme', () => {
    const out = redactBrowserAutomationTimelineDetails({
      target: `javascript:fetch('https://x.test/?t=${QUERY_TOKEN}')`,
    }) as Record<string, unknown>;
    expect(serialized(out)).not.toContain(QUERY_TOKEN);
  });

  it('keeps benign path segments readable (no blanket path erasure)', () => {
    const out = serialized(redactBrowserAutomationTimelineDetails({
      href: 'https://app.example.test/settings/profile',
    }));
    expect(out).toContain('/settings/profile');
  });

  it('still drops forbidden keys entirely (superset rejector parity)', () => {
    const out = redactBrowserAutomationTimelineDetails({
      screenshotDataUri: 'data:image/png;base64,AAAA',
      domSnapshot: '<html></html>',
      localStorage: { k: 'v' },
      cookie: 'a=b',
      fine: 'ok',
    }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['fine']);
  });
});

describe('redactBrowserAutomationActionResultDetails — locator preservation stays intact', () => {
  it('preserves bounded locator values but still strips URL-shaped values elsewhere', () => {
    const out = redactBrowserAutomationActionResultDetails({
      selector: 'role=button[name="Reset"]',
      href: SEEDED_URL,
    }) as Record<string, unknown>;
    expect(out.selector).toBe('role=button[name="Reset"]');
    expect(serialized(out)).not.toContain(QUERY_TOKEN);
    expect(serialized(out)).not.toContain(PATH_TOKEN);
  });
});
