import { describe, expect, it } from 'vitest';
import { BrowserFocusedCredentialTargetV1Schema } from '../context/v1.js';
import { BrowserAutomationSecretFillRequestV1Schema } from './v1.js';
import { redactDiagnosticsHeadersWithResult } from '../diagnostics/egress/headers.js';

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
  it('preserves an exact focused credential origin through result redaction and confidential admission', () => {
    const target = BrowserFocusedCredentialTargetV1Schema.parse({
      browserSessionId: 'owned-session', viewId: 'dummy-login', tabId: 'tab', frameId: 'frame',
      documentId: 'document', navigationGeneration: 0, origin: 'http://127.0.0.1:41589',
      field: { fieldId: '2', focusId: '2', locator: '#dummy-password' },
    });
    const result = redactBrowserAutomationActionResultDetails({ focusedCredentialTarget: target });
    expect(result).toEqual({ focusedCredentialTarget: target });
    const projected = BrowserFocusedCredentialTargetV1Schema.parse(
      result !== null && typeof result === 'object' && 'focusedCredentialTarget' in result
        ? result.focusedCredentialTarget : undefined,
    );
    expect(BrowserAutomationSecretFillRequestV1Schema.parse({
      ...projected, serverId: 'home', sessionId: 'owned-session', machineId: 'machine',
      purpose: 'Fill the dummy login without submitting',
    }).origin).toBe(target.origin);
  });
  it('preserves complete safe timeline strings without claiming content was omitted', () => {
    const details = { note: 'visible '.repeat(100), truncated: false };
    expect(redactBrowserAutomationActionResultDetails(details)).toEqual(details);
    expect(redactBrowserAutomationTimelineDetails(details)).toEqual(details);
  });
  it('preserves complete readable results while timeline text and locators remain metadata-only', () => {
    const selector = `[data-testid="${'long-selector-'.repeat(100)}"]`;
    const visibleText = 'Visible page content '.repeat(100);
    const details = { visibleText, text: visibleText, selector, elements: Array.from({ length: 40 }, (_, index) => ({ name: `Item ${index}`, selector })) };
    const result = redactBrowserAutomationActionResultDetails(details) as typeof details;
    expect(result.visibleText).toBe(visibleText);
    expect(result.text).toBe(visibleText);
    expect(result.selector).toBe(selector);
    expect(result.elements).toHaveLength(40);
    const timeline = redactBrowserAutomationTimelineDetails(details) as Record<string, unknown>;
    expect(timeline.textLength).toBe(visibleText.length);
    expect(timeline.selectorAvailable).toBe(true);
    expect(timeline.elements).toHaveLength(40);
  });

  it('redacts secrets throughout deep timeline details without dropping safe nested content', () => {
    let details: unknown = { note: 'safe '.repeat(80), href: SEEDED_URL, cookie: 'secret' };
    for (let index = 0; index < 12; index++) details = { child: details };
    let expected: unknown = { note: 'safe '.repeat(80), href: 'https://app.example.test/reset/:redacted' };
    for (let index = 0; index < 12; index++) expected = { child: expected };
    expect(redactBrowserAutomationTimelineDetails(details)).toEqual(expected);
    expect(redactBrowserAutomationTimelineDetails(Array.from({ length: 30 }, () => details))).toEqual(
      Array.from({ length: 30 }, () => expected),
    );
  });

  it('preserves long safe telemetry headers while excluding credential-bearing headers', () => {
    const safe = 'text/plain; profile=readable '.repeat(30);
    expect(redactDiagnosticsHeadersWithResult({ 'content-type': safe, authorization: 'secret',
      'sec-websocket-protocol': 'secret' })).toEqual({ headers: { 'content-type': safe }, truncated: false });
  });

  it('applies URL and secret-key floors even inside preserved agent locators and arrays', () => {
    const result = redactBrowserAutomationActionResultDetails({ selector: `[href="${SEEDED_URL}"]`, entries: Array.from({ length: 40 }, () => ({ href: SEEDED_URL, cookie: 'secret' })) });
    expect(serialized(result)).not.toContain(QUERY_TOKEN);
    expect(serialized(result)).not.toContain(PATH_TOKEN);
    expect(serialized(result)).not.toContain('cookie');
  });
  it('omits unsafe locators rather than changing their executable target', () => {
    const details = { selector: `[href="${SEEDED_URL}"]`, locator: { kind: 'css', value: `[href="${SEEDED_URL}"]` } };
    const result = redactBrowserAutomationActionResultDetails(details);
    expect(result).toMatchObject({ selectorAvailable: false, locatorAvailable: false, truncated: true });
    expect(result).not.toHaveProperty('selector');
    expect(result).not.toHaveProperty('locator');
    expect(serialized(result)).not.toContain(QUERY_TOKEN);
  });
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
